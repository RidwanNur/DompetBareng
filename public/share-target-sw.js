const maxReceiptBytes = 4 * 1024 * 1024;
const maxMultipartBytes = maxReceiptBytes + 64 * 1024;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function canReceiveShare(request, appOrigin) {
  const source = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return (
    (site === null || site === "none" || site === "same-origin") &&
    (source === null || source === appOrigin || (source === "null" && site === "none"))
  );
}

function redirectToShareResult(appOrigin, result) {
  const path = result === "login" ? "/login" : "/";
  const url = new URL(path, appOrigin);
  url.searchParams.set("shared", result);
  return Response.redirect(url, 303);
}

function readSharedForm(request) {
  const contentType = request.headers.get("content-type");
  if (
    !request.body ||
    contentType?.split(";", 1)[0].trim().toLowerCase() !== "multipart/form-data" ||
    Number(request.headers.get("content-length")) > maxMultipartBytes
  ) {
    return null;
  }

  let bytesRead = 0;
  const boundedBody = request.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxMultipartBytes) {
        controller.error(new Error("Ukuran foto terlalu besar."));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(boundedBody, { headers: { "content-type": contentType } }).formData();
}

async function receiveReceipt(request, appOrigin) {
  let input;
  try {
    input = await readSharedForm(request);
  } catch {
    return redirectToShareResult(appOrigin, "invalid");
  }
  const receipts = input?.getAll("receipt") ?? [];
  const [receipt] = receipts;
  if (
    receipts.length !== 1 ||
    !(receipt instanceof File) ||
    receipt.size === 0 ||
    receipt.size > maxReceiptBytes
  ) {
    return redirectToShareResult(appOrigin, "invalid");
  }

  const body = new FormData();
  body.set("receipt", receipt);
  body.set("input_id", crypto.randomUUID());

  try {
    const response = await fetch(new URL("/api/transactions", appOrigin), {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body,
    });
    if (response.ok) return redirectToShareResult(appOrigin, "success");
    if (response.status === 401) return redirectToShareResult(appOrigin, "login");
    if (response.status === 429) return redirectToShareResult(appOrigin, "limited");
    if ([400, 413, 415, 422].includes(response.status)) {
      return redirectToShareResult(appOrigin, "invalid");
    }
  } catch {
    // The upload can be attempted again from the device's share menu.
  }
  return redirectToShareResult(appOrigin, "failed");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const appOrigin = self.location.origin;
  const url = new URL(request.url);
  if (
    url.origin !== appOrigin || url.pathname !== "/api/share-target" ||
    request.method !== "POST" || request.mode !== "navigate" ||
    request.destination !== "document"
  ) {
    return;
  }
  if (!canReceiveShare(request, appOrigin)) {
    event.respondWith(new Response(null, { status: 403 }));
    return;
  }
  event.respondWith(receiveReceipt(request, appOrigin));
});
