import type { DatabaseSync } from 'node:sqlite';
import { jsonCopy } from '../graph/data.ts';
import { fingerprint } from '../util.ts';
import type { Json } from '../types.ts';
import type { SqliteInvariantProgram, SqliteMigrationProgram, SqliteReadProgram, SqliteWriteProgram } from './types.ts';

export function createConversationV1(database:DatabaseSync):void{
  database.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL) STRICT;
    CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),user_id TEXT NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at TEXT NOT NULL) STRICT;
    INSERT INTO users VALUES('user-alice','Alice'),('user-bob','Bob');
    INSERT INTO conversations VALUES('conversation-alice','user-alice','Alice history','2026-01-01T00:00:00Z'),('conversation-bob','user-bob','Bob history','2026-01-02T00:00:00Z');
    INSERT INTO messages VALUES('message-alice-1','conversation-alice','user-alice','Private π conversation','2026-01-01T00:00:01Z'),('message-alice-2','conversation-alice','user-alice','Keep every stable ID','2026-01-01T00:00:02Z'),('message-bob-1','conversation-bob','user-bob','Bob message history','2026-01-02T00:00:01Z');`);
}
export function conversationRecords(database:DatabaseSync):Json{
  if(database.prepare('SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.user_id<>c.user_id').all().length)throw Error('Conversation owner invariant failed');
  return jsonCopy({users:database.prepare('SELECT id,name FROM users ORDER BY id').all(),conversations:database.prepare('SELECT id,user_id,title,created_at FROM conversations ORDER BY id').all(),messages:database.prepare('SELECT id,conversation_id,user_id,body,created_at FROM messages ORDER BY id').all()});
}
export const conversationInvariants:SqliteInvariantProgram=Object.freeze({id:'preserve-conversations',digest:fingerprint({version:1,fields:['users:id,name','conversations:id,user_id,title,created_at','messages:id,conversation_id,user_id,body,created_at'],ownership:'message-author-matches-conversation-owner'}),read:conversationRecords});
export const conversationMigrationV2:SqliteMigrationProgram=Object.freeze({id:'conversation-schema-v2',digest:fingerprint({version:2,change:'messages.delivery_state=stored,index,version-table'}),run(database:DatabaseSync){
  database.exec("ALTER TABLE messages ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'stored'; CREATE INDEX messages_by_conversation ON messages(conversation_id,created_at); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_by TEXT NOT NULL) STRICT; INSERT INTO schema_migrations VALUES(2,'registered-local-v2');");
}});
export const conversationReadPrograms:readonly SqliteReadProgram[]=Object.freeze([
  {id:'records',run:database=>conversationRecords(database)},
  {id:'summary',run:database=>jsonCopy({schemaVersion:database.prepare('PRAGMA user_version').get()!.user_version,
    users:database.prepare('SELECT count(*) AS count FROM users').get()!.count,conversations:database.prepare('SELECT count(*) AS count FROM conversations').get()!.count,messages:database.prepare('SELECT count(*) AS count FROM messages').get()!.count})},
  {id:'v2-health',run:database=>jsonCopy({schemaVersion:database.prepare('PRAGMA user_version').get()!.user_version,stored:database.prepare("SELECT count(*) AS count FROM messages WHERE delivery_state='stored'").get()!.count,messages:database.prepare('SELECT count(*) AS count FROM messages').get()!.count})},
]);
export const conversationWritePrograms:readonly SqliteWriteProgram[]=Object.freeze([{id:'append-message',run(database,input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='body,conversationId,createdAt,id,userId')throw Error('Supply bounded message values');
  const value=input as Record<string,Json>;
  for(const key of ['id','conversationId','userId','createdAt','body'])if(typeof value[key]!=='string'||!value[key]||String(value[key]).length>(key==='body'?4096:160))throw Error('Invalid conversation message');
  const owner=database.prepare('SELECT user_id FROM conversations WHERE id=?').get(String(value.conversationId));if(owner?.user_id!==value.userId)throw Error('Only the conversation owner can append this example message');
  database.prepare('INSERT INTO messages(id,conversation_id,user_id,body,created_at) VALUES(?,?,?,?,?)').run(String(value.id),String(value.conversationId),String(value.userId),String(value.body),String(value.createdAt));
  return {id:String(value.id)};
}}]);
