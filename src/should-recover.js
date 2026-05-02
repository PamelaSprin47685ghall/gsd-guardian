import { extractText } from "./extract-text.js";
import { isUserCancellation } from "./user-cancellation.js";

export function shouldRecover(lastMsg) {
  if (!lastMsg) return false;
  if (isUserCancellation(lastMsg)) return false;
  
  const isError = lastMsg.stopReason === "error";
  const isAbortedWithError = lastMsg.stopReason === "aborted";
  
  return isError || isAbortedWithError;
}
