export const copyToClipboard = (text: string) => {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(err => console.error("Clipboard write failed", err));
  } else {
    // Fallback for insecure contexts (e.g., HTTP without localhost)
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "absolute";
    textArea.style.left = "-999999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand("copy");
    } catch (error) {
      console.error("Fallback copy failed", error);
    }
    document.body.removeChild(textArea);
  }
};
