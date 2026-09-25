import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatReq, makeRig, runChat } from './helpers.ts';

test('a tracker question calls the tool and quotes the tracker exactly', async () => {
  const rig = await makeRig();
  try {
    const r = await runChat(rig.assistant, chatReq('Which jobs am I interviewing for?'));
    assert.equal(r.error, null);
    assert.match(r.text, /Data Analyst at Acme \(Interviewing\)/);
    assert.equal(r.done?.incomplete, false);
    assert.ok(r.done?.chatId);
    const chat = rig.assistant.getChat(r.done!.chatId!);
    assert.equal(chat.messages.length, 2);
    assert.equal(chat.messages[1]!.incomplete, undefined);
  } finally { await rig.close(); }
});
