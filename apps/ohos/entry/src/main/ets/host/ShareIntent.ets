import type { Want } from '@kit.AbilityKit';

const SEND_DATA = 'ohos.want.action.sendData';
const CONTENT_KEYS: string[] = [
  'ohos.extra.param.key.content',
  'ohos.extra.param.key.text',
  'content',
  'text'
];

export function extractSharedText(want: Want): string | undefined {
  if (want.action !== SEND_DATA || want.type !== 'text/plain' || want.parameters === undefined) {
    return undefined;
  }
  for (const key of CONTENT_KEYS) {
    const value = want.parameters[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
