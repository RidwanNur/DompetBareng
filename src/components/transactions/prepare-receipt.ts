const maxUploadBytes = 4 * 1024 * 1024;

export async function prepareReceipt(file: File) {
  if (file.size <= maxUploadBytes) return file;

  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error();

    const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size > maxUploadBytes) throw new Error();
    return new File([blob], "struk.jpg", { type: "image/jpeg" });
  } finally {
    image.close();
  }
}
