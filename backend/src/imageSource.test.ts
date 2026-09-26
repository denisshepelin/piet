import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_BYTES,
  pagePreviewImageUrl,
  resolveImageSource,
  sniffImageMimeType,
  type ImageSourceDeps,
} from "./imageSource.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

type Route = { body: Uint8Array | string; type?: string; status?: number };

const deps = (routes: Record<string, Route>, files: Record<string, Uint8Array> = {}) => {
  const requested: string[] = [];

  const fake: ImageSourceDeps = {
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      const route = routes[url];

      if (!route) return new Response("missing", { status: 404, statusText: "Not Found" });

      const response = new Response(route.body, {
        status: route.status ?? 200,
        headers: route.type ? { "content-type": route.type } : {},
      });

      Object.defineProperty(response, "url", { value: url });

      return response;
    },
    readFile: async (path) => {
      const file = files[path];

      if (!file) throw new Error(`ENOENT: ${path}`);

      return file;
    },
    cwd: () => "/work/piet/backend",
    homedir: () => "/home/me",
  };

  return { fake, requested };
};

test("fetches image URLs in the backend and returns a data URL", async () => {
  const { fake } = deps({ "https://img.example/a/cat.png": { body: PNG, type: "image/png" } });
  const image = await resolveImageSource("https://img.example/a/cat.png", undefined, fake);
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.name, "cat.png");
  assert.equal(image.src, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
  assert.equal(image.origin, "https://img.example/a/cat.png");
});

test("sniffs mislabelled image responses", async () => {
  const { fake } = deps({
    "https://cdn.example/blob": { body: JPEG, type: "application/octet-stream" },
  });

  const image = await resolveImageSource("https://cdn.example/blob", undefined, fake);
  assert.equal(image.mimeType, "image/jpeg");
});

test("follows a web page's preview image, including pages named like image files", async () => {
  const page = "https://commons.example/wiki/File:Beethoven.jpg";

  const { fake, requested } = deps({
    [page]: {
      body: `<html><head><meta content="/thumb/b.jpg?w=1&amp;h=2" property="og:image"></head></html>`,
      type: "text/html; charset=UTF-8",
    },
    "https://commons.example/thumb/b.jpg?w=1&h=2": { body: JPEG, type: "image/jpeg" },
  });

  const image = await resolveImageSource(page, undefined, fake);
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.origin, "https://commons.example/thumb/b.jpg?w=1&h=2");
  assert.deepEqual(requested, [page, "https://commons.example/thumb/b.jpg?w=1&h=2"]);
});

test("reports pages without a preview image and non-image responses", async () => {
  const { fake } = deps({
    "https://example.com/": { body: "<html><title>x</title></html>", type: "text/html" },
    "https://example.com/data.json": { body: "{}", type: "application/json" },
  });

  await assert.rejects(
    resolveImageSource("https://example.com/", undefined, fake),
    /without a preview image/,
  );
  await assert.rejects(
    resolveImageSource("https://example.com/data.json", undefined, fake),
    /not an image/,
  );
  await assert.rejects(
    resolveImageSource("https://example.com/missing.png", undefined, fake),
    /404/,
  );
});

test("reads local image files by absolute, home, file URL, and relative paths", async () => {
  const { fake } = deps(
    {},
    {
      "/tmp/shot.png": PNG,
      "/home/me/Pictures/me.jpg": JPEG,
      "/work/piet/docs/arch.svg": new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
    },
  );

  assert.equal((await resolveImageSource("/tmp/shot.png", undefined, fake)).mimeType, "image/png");
  assert.equal(
    (await resolveImageSource("~/Pictures/me.jpg", undefined, fake)).origin,
    "/home/me/Pictures/me.jpg",
  );
  assert.equal(
    (await resolveImageSource("file:///tmp/shot.png", undefined, fake)).name,
    "shot.png",
  );
  assert.equal(
    (await resolveImageSource("../docs/arch.svg", undefined, fake)).mimeType,
    "image/svg+xml",
  );
});

test("passes data URLs through and rejects images over the transport limit", async () => {
  const { fake } = deps({
    "https://img.example/huge.png": {
      body: new Uint8Array(MAX_IMAGE_BYTES + 1),
      type: "image/png",
    },
  });

  const inline = await resolveImageSource("data:image/svg+xml;base64,PHN2Zy8+", undefined, fake);
  assert.equal(inline.src, "data:image/svg+xml;base64,PHN2Zy8+");
  assert.equal(inline.mimeType, "image/svg+xml");
  await assert.rejects(
    resolveImageSource("https://img.example/huge.png", undefined, fake),
    /smaller rendition/,
  );
});

test("preview image extraction prefers Open Graph over Twitter and image_src", () => {
  const html = `<link rel="image_src" href="/c.png"><meta name="twitter:image" content="/b.png"><meta property="og:image" content='https://x.example/a.png'>`;
  assert.equal(pagePreviewImageUrl(html, "https://x.example/p"), "https://x.example/a.png");
  assert.equal(
    pagePreviewImageUrl(`<link rel="image_src" href="/c.png">`, "https://x.example/p"),
    "https://x.example/c.png",
  );
  assert.equal(sniffImageMimeType(new TextEncoder().encode("hello")), undefined);
});
