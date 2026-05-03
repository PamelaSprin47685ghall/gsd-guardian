import { extractText } from "./extract-text.js";

export function isUserCancellation(lastMsg) {
  if (!lastMsg) return false;
  if (lastMsg.stopReason !== "aborted") return false;

  const errorMsg = extractText(lastMsg.errorMessage);
  const content = extractText(lastMsg.content);

  // User cancellation patterns (Esc/Ctrl+C):
  // 1. Explicit user abort: no errorMessage, no content
  // 2. Explicit "Operation aborted" / "Request aborted" from user gesture
  //
  // Non-cancellation (system-originated) aborts have errorMessage with
  // operational context — timeout, dispatch-stop, tool errors, etc.
  // These are NOT user cancellations and should be recoverable.
  const hasEmptyContent = !content || content.trim().length === 0;
  const hasEmptyError = !errorMsg || errorMsg.trim().length === 0;

  // Empty content + empty error = user pressed Esc/Ctrl+C
  if (hasEmptyContent && hasEmptyError) return true;

  // Explicit abort strings from user gesture
  if (errorMsg === "Operation aborted") return true;

  // Everything else (timeout, dispatch-stop, tool abort, etc.) is NOT user cancellation
  return false;
}
