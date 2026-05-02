import { isUserCancellation } from "./user-cancellation.js";

export function shouldRecover(lastMsg) {
  if (!lastMsg) return false;
  
  // First principle: only DON'T recover on:
  // 1. User cancellation (Esc/Ctrl+C)
  // 2. Normal completion (stopReason: "stop", "end_turn", "max_tokens")
  
  if (isUserCancellation(lastMsg)) return false;
  
  const normalCompletion = 
    lastMsg.stopReason === "stop" ||
    lastMsg.stopReason === "end_turn" ||
    lastMsg.stopReason === "max_tokens";
  
  if (normalCompletion) return false;
  
  // Everything else (errors, aborted with error, validation failures, etc.) should recover
  return true;
}
