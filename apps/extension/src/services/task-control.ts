import { taskControlResponseSchema, type TaskControlCommand, type TaskControlResponse } from '@clickflow/shared';
export async function taskControl(command: TaskControlCommand): Promise<TaskControlResponse> {
  return taskControlResponseSchema.parse(await chrome.runtime.sendMessage(command));
}
