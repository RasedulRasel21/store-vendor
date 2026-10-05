// Lets a plain node run resolve the app's extensionless relative imports.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

if (process.env.ZONES_LOADER !== "child") {
  process.env.ZONES_LOADER = "child";
  register(pathToFileURL(import.meta.filename));
}

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
      return next(`${specifier}.js`, context);
    }
    throw error;
  }
}

// Route files are .jsx even when they hold no JSX at all; node won't load one without
// being told it's a module.
export async function load(url, context, next) {
  if (url.endsWith(".jsx")) return next(url, { ...context, format: "module" });
  return next(url, context);
}
