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

test('a conversation saved before tool steps were kept opens as before, and new answers keep their steps', async () => {
  const { openAssistantDb, migrateAssistant } = await import('../src/db.ts');
  const { ChatStore } = await import('../src/chats.ts');
  const db = openAssistantDb(':memory:');
  // The file as an earlier jobleft left it: no tools_json column, one saved answer.
  db.exec('ALTER TABLE ai_chat_messages DROP COLUMN tools_json');
  const store0 = new ChatStore(db);
  db.exec("INSERT INTO ai_chats (id, title, job_id, created_at, updated_at) VALUES ('chat_old', 'Old', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')");
  db.exec("INSERT INTO ai_chat_messages (chat_id, role, content, at) VALUES ('chat_old', 'assistant', 'An old answer.', '2026-10-01T00:00:00.000Z')");
  migrateAssistant(db);
  assert.deepEqual(store0.get('chat_old')!.messages.map((m) => [m.content, 'tools' in m]), [['An old answer.', false]]);
  const row = store0.beginAssistant('chat_old');
  const tool = { id: 'tool_1', name: 'web_search', state: 'done' as const, label: 'Searching the web', steps: ['Asking your search engine: SOC analyst'], sources: [{ title: 'A job', url: 'https://example.com/job' }], summary: '1 job found' };
  store0.setAssistant(row, 'A new answer.', { incomplete: false, tools: [tool] });
  assert.deepEqual(store0.get('chat_old')!.messages[1]!.tools, [tool]);
  db.close();
});
