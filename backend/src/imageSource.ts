import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raw image bytes stay below the canvas socket payload limit once base64 encoded. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const USER_AGENT = "Piet/0.1 (local canvas assistant)";

export type ResolvedImage = {
  src: string;
  mimeType: string;
  name: string;
  origin: string;
  bytes: number;
};

export type ImageSourceDeps = {
  fetch: typeof fetch;
  readFile: (path: string) => Promise<Uint8Array>;
  cwd: () => string;
  homedir: () => string;
};

const defaultDeps: ImageSourceDeps = {
  fetch: (input, init) => fetch(input, init),
  readFile: (path) => readFile(path),
  cwd: () => process.cwd(),
  homedir,
};

const EXTENSION_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
]);

const startsWithBytes = (bytes: Uint8Array, prefix: number[], offset = 0): boolean =>
  prefix.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** Detects common image formats from magic bytes so mislabelled responses still import. */
export const sniffImageMimeType = (bytes: Uint8Array): string | undefined => {
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";

  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  if (startsWithBytes(bytes, ascii("GIF8"))) return "image/gif";

  if (startsWithBytes(bytes, ascii("RIFF")) && startsWithBytes(bytes, ascii("WEBP"), 8))
    return "image/webp";

  if (startsWithBytes(bytes, ascii("ftypavif"), 4)) return "image/avif";

  if (startsWithBytes(bytes, ascii("BM"))) return "image/bmp";

  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();

  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";

  return undefined;
};

const decodeEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const tagAttributes = (tag: string): Record<string, string> =>
  Object.fromEntries(
    [...tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map(
      ([, key = "", double, single, bare]) => [
        key.toLowerCase(),
        decodeEntities(double ?? single ?? bare ?? ""),
      ],
    ),
  );

const PREVIEW_META_KEYS = [
  "og:image:secure_url",
  "og:image:url",
  "og:image",
  "twitter:image",
  "twitter:image:src",
];

/** Finds the preview image a web page advertises (Open Graph, Twitter card, or image_src). */
export const pagePreviewImageUrl = (html: string, pageUrl: string): string | undefined => {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tagAttributes(tag));

  const links = [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(([tag]) => {
    const attributes = tagAttributes(tag);

    return attributes.rel?.toLowerCase() === "image_src" ? [attributes] : [];
  });

  const candidates = [
    ...PREVIEW_META_KEYS.flatMap((key) =>
      metas.flatMap((attributes) =>
        (attributes.property ?? attributes.name)?.toLowerCase() === key && attributes.content
          ? [attributes.content]
          : [],
      ),
    ),
    ...links.flatMap((attributes) => (attributes.href ? [attributes.href] : [])),
  ];

  for (const candidate of candidates) {
    try {
      return new URL(candidate, pageUrl).href;
    } catch {
      // try the next advertised image
    }
  }

  return undefined;
};

const dataUrl = (mimeType: string, bytes: Uint8Array): string =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;

const checkSize = (bytes: number, origin: string): void => {
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `image at ${origin} is ${bytes} bytes; the limit is ${MAX_IMAGE_BYTES} bytes. Use a smaller rendition or thumbnail URL.`,
    );
  }
};

const nameFromUrl = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "");
  } catch {
    return "";
  }
};

const fetchImage = async (
  url: string,
  signal: AbortSignal | undefined,
  deps: ImageSourceDeps,
  followPage: boolean,
): Promise<ResolvedImage> => {
  const init: RequestInit = {
    headers: {
      "user-agent": USER_AGENT,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*,text/html;q=0.8,*/*;q=0.5",
    },
    redirect: "follow",
  };

  if (signal) init.signal = signal;
  const response = await deps.fetch(url, init);

  if (!response.ok) {
    throw new Error(`image fetch failed for ${url} (${response.status} ${response.statusText})`);
  }

  const finalUrl = response.url || url;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  checkSize(declaredLength, finalUrl);
  const bytes = new Uint8Array(await response.arrayBuffer());
  checkSize(bytes.length, finalUrl);

  const declaredType = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();

  const isPage = declaredType === "text/html" || declaredType === "application/xhtml+xml";

  const mimeType = declaredType.startsWith("image/")
    ? declaredType
    : (sniffImageMimeType(bytes) ??
      (isPage
        ? undefined
        : EXTENSION_MIME_TYPES.get(extname(nameFromUrl(finalUrl)).toLowerCase())));

  if (mimeType) {
    return {
      src: dataUrl(mimeType, bytes),
      mimeType,
      name: nameFromUrl(finalUrl) || "piet-image",
      origin: finalUrl,
      bytes: bytes.length,
    };
  }

  if (followPage && isPage) {
    const preview = pagePreviewImageUrl(new TextDecoder().decode(bytes), finalUrl);

    if (!preview) {
      throw new Error(
        `${finalUrl} is a web page without a preview image (og:image); pass a direct image URL`,
      );
    }

    return fetchImage(preview, signal, deps, false);
  }

  throw new Error(`${finalUrl} is not an image (content-type '${declaredType || "unknown"}')`);
};

const localPath = (src: string, deps: ImageSourceDeps): string => {
  if (src.startsWith("file://")) return fileURLToPath(src);

  if (src === "~" || src.startsWith("~/")) return resolve(deps.homedir(), src.slice(2));

  return resolve(deps.cwd(), src);
};

const readLocalImage = async (src: string, deps: ImageSourceDeps): Promise<ResolvedImage> => {
  const path = localPath(src, deps);
  const bytes = await deps.readFile(path);
  checkSize(bytes.length, path);

  const mimeType =
    sniffImageMimeType(bytes) ?? EXTENSION_MIME_TYPES.get(extname(path).toLowerCase());

  if (!mimeType) throw new Error(`${path} is not a recognized image file`);

  return {
    src: dataUrl(mimeType, bytes),
    mimeType,
    name: basename(path),
    origin: path,
    bytes: bytes.length,
  };
};

/**
 * Resolves an image URL, web page URL, local path, or data URL into a data URL the browser can
 * import without cross-origin restrictions.
 */
export const resolveImageSource = async (
  src: string,
  signal?: AbortSignal,
  deps: ImageSourceDeps = defaultDeps,
): Promise<ResolvedImage> => {
  const trimmed = src.trim();

  if (trimmed.startsWith("data:")) {
    const mimeType = /^data:([^;,]+)/.exec(trimmed)?.[1] ?? "";

    return {
      src: trimmed,
      mimeType,
      name: "piet-image",
      origin: "data URL",
      bytes: trimmed.length,
    };
  }

  if (/^https?:\/\//i.test(trimmed)) return fetchImage(trimmed, signal, deps, true);

  return readLocalImage(trimmed, deps);
};
