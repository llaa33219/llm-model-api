// Give workers-types the top-level exports used through ctx.exports.
// See https://developers.cloudflare.com/workers/runtime-apis/context/#exports
import type * as MainModule from "./src/index";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof MainModule;
    }
  }
}

export {};
