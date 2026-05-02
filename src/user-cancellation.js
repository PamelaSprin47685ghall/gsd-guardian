import { extractText } from "./extract-text.js";

export function isUserCancellation(lastMsg) {
  if (!lastMsg) return false;
  if (lastMsg.stopReason !== "aborted") return false;

  const errorMsg = extractText(lastMsg.errorMessage);
  const content = extractText(lastMsg.content);

  // User cancellation patterns:
  // 1. Empty content + no errorMessage
  // 2. errorMessage is "Request was aborted" or "Operation aborted"
  // 3. Empty content + empty errorMessage
  const hasEmptyContent = !content || content.trim().length === 0;
  const hasNoError = !errorMsg || errorMsg.trim().length === 0;
  const isAbortMessage = errorMsg === "Request was aborted" || errorMsg === "Operation aborted";

  return (hasEmptyContent && hasNoError) || isAbortMessage;
}
