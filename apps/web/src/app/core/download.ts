export function downloadText(filename: string, contents: string, mediaType: string): void {
  const blob = new Blob([contents], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}
