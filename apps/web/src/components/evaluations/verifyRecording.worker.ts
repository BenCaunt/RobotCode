import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

self.onmessage = async ({ data }: MessageEvent<{ url: string; digest: string }>) => {
  try {
    const response = await fetch(data.url, { cache: "no-store" });
    if (!response.ok) throw new Error("Recording unavailable");
    const blob = await response.blob();
    const hash = sha256.create();
    const reader = blob.stream().getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
    self.postMessage(bytesToHex(hash.digest()) === data.digest ? blob : null, { transfer: [] });
  } catch {
    self.postMessage("error", { transfer: [] });
  }
};
