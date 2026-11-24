-- Synthetic snapshot of the Python platform's persisted v2 schema.
PRAGMA user_version=2;
CREATE TABLE chats(id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE turns(id TEXT PRIMARY KEY, chat TEXT NOT NULL REFERENCES chats(id), text TEXT NOT NULL, state TEXT NOT NULL, answer TEXT);
CREATE INDEX turns_chat ON turns(chat);
CREATE TABLE channels(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
CREATE TABLE placement(chat TEXT PRIMARY KEY REFERENCES chats(id), channel TEXT NOT NULL REFERENCES channels(id));
CREATE TABLE notifications(request TEXT PRIMARY KEY REFERENCES turns(id), unread INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)));
INSERT INTO channels VALUES ('general','General');
INSERT INTO chats VALUES ('old','Old title');
INSERT INTO placement VALUES ('old','general');
INSERT INTO turns VALUES ('one','old','旧问题','answered','旧回复'),('two','old','Another message','unknown',NULL),('three','old','Queued next','queued',NULL);
INSERT INTO notifications VALUES ('one',0);
