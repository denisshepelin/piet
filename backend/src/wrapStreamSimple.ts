import type { Models } from "@earendil-works/pi-ai";

/**
 * Model access whose chat streaming goes through `wrap`. Durable generation streams through `streamSimple`; every
 * other member is the wrapped instance's own, bound to it.
 */
export const wrapStreamSimple = (
  models: Models,
  wrap: (streamSimple: Models["streamSimple"]) => Models["streamSimple"],
): Models => {
  const streamSimple = wrap((model, context, options) =>
    models.streamSimple(model, context, options),
  );

  return new Proxy(models, {
    get: (target, property) => {
      if (property === "streamSimple") return streamSimple;

      // SAFETY: a Models proxy is only read through the Models interface, so property names a member of it.
      const member = target[property as keyof Models];

      return member instanceof Function ? member.bind(target) : member;
    },
  });
};
