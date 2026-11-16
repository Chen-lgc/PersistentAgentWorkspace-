import { constants, fstatSync, openSync, readFileSync, realpathSync, closeSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { TurnPdfInput } from "../contracts.ts";
import { ATTACHMENTS_DIR } from "../attachments.ts";
import { TURN_PDF_MAX_BYTES } from "../turn-images.ts";
import type { ChatFilePart } from "./chat-images.ts";

export function chatPdfParts(pdfs: readonly TurnPdfInput[], attachmentsDir = ATTACHMENTS_DIR): ChatFilePart[] {
  let total = 0;
  return pdfs.map((pdf) => {
    const storedName = basename(pdf.path);
    const suggestedName = pdf.name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
    const filename = suggestedName && /\.pdf$/i.test(suggestedName) ? suggestedName : storedName;
    const path = resolve(attachmentsDir, storedName);
    if (resolve(pdf.path) !== path || dirname(realpathSync(path)) !== realpathSync(attachmentsDir)) {
      throw new Error("PDF attachment is outside QBot's private attachment store.");
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd);
      if (!size.isFile() || size.size !== pdf.bytes || size.size <= 0 || size.size > TURN_PDF_MAX_BYTES || total + size.size > TURN_PDF_MAX_BYTES) {
        throw new Error("PDF attachments for one model turn are limited to 20 MB total.");
      }
      const data = readFileSync(fd);
      if (!data.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The attached file is not a PDF.");
      total += data.length;
      return { type: "file", file: { filename, file_data: `data:application/pdf;base64,${data.toString("base64")}` } };
    } finally {
      closeSync(fd);
    }
  });
}
