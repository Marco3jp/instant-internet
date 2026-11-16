import { prepareZXingModule, readBarcodes } from "https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.6/dist/es/reader/index.js";

prepareZXingModule({ fireImmediately: true }).then(
  () => postMessage({ type: "ready" }),
  (error) => postMessage({ type: "fatal", message: String(error?.message || error) }),
);

self.onmessage = async (event) => {
  const { id, width, height, data, options } = event.data;
  const startedAt = performance.now();
  try {
    const results = await readBarcodes(new ImageData(data, width, height), options);
    postMessage({
      id,
      ms: performance.now() - startedAt,
      results: results
        .filter((r) => r.isValid && r.text !== "")
        .map((r) => ({
          format: r.format,
          text: r.text,
          position: r.position,
          isMirrored: r.isMirrored,
          isInverted: r.isInverted,
          extra: r.extra,
        })),
    });
  } catch (error) {
    postMessage({ id, error: String(error?.message || error) });
  }
};
