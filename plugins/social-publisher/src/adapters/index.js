import { InstagramAdapter } from "./instagram.js";
import { FacebookPageAdapter } from "./facebook.js";
import { ThreadsAdapter } from "./threads.js";
import { XAdapter } from "./x.js";

export const ADAPTERS = {
  instagram: new InstagramAdapter(),
  facebook_page: new FacebookPageAdapter(),
  threads: new ThreadsAdapter(),
  x: new XAdapter(),
};

export function getAdapter(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new Error(`Unsupported platform adapter: ${platform}`);
  }
  return adapter;
}
