import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { reportError } from "./models/error-report.server";

export const streamTimeout = 5000;

// Every error React Router doesn't handle itself comes through here: a loader that threw,
// an action that blew up, a page that couldn't render. Catching them in one place means a
// route doesn't have to remember to report its own failures.
export function handleError(error, { request }) {
  // A visitor closing the tab mid-request isn't a fault.
  if (request.signal.aborted) return;
  // Neither is a bot asking for a page that was never there, or a request turned away for
  // not being signed in. Only the 500s are ours.
  if (isRouteErrorResponse(error) && error.status < 500) return;

  const url = new URL(request.url);
  void reportError(error, {
    context: `${request.method} ${url.pathname}`,
    // Embedded admin requests carry the shop, so most of these land on the right
    // merchant's health page without being told.
    shop: url.searchParams.get("shop") ?? undefined,
  });
}

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
