import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// 既定では jsDelivr から wasm を取りに行くので、ビルドに同梱したファイルを使わせる
prepareZXingModule({
  overrides: {
    locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  },
  fireImmediately: true,
}).then(
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
