use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use uuid::Uuid;

use crate::error::{HostError, HostResult};
use crate::paths::now_rfc3339;

const CURRENT_DATABASE_VERSION: i64 = 2;
const MAX_STATE_DOCUMENT_BYTES: usize = 256 * 1024 * 1024;

pub struct Database {
    connection: Connection,
    #[cfg(test)]
    database_backup_directory: PathBuf,
}

impl Database {
    pub fn open(app_data_directory: &Path) -> HostResult<Self> {
        fs::create_dir_all(app_data_directory).map_err(|error| {
            HostError::io("failed to create private application data directory", error)
        })?;
        let database_path = app_data_directory.join("granite.sqlite3");
        let backup_directory = app_data_directory.join("backups").join("database");
        fs::create_dir_all(&backup_directory)
            .map_err(|error| HostError::io("failed to create database backup directory", error))?;

        let mut connection = Connection::open(&database_path)
            .map_err(|error| HostError::db("failed to open private SQLite database", error))?;
        connection
            .busy_timeout(Duration::from_secs(10))
            .map_err(|error| HostError::db("failed to configure SQLite busy timeout", error))?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|error| HostError::db("failed to enable SQLite foreign keys", error))?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| HostError::db("failed to enable SQLite WAL mode", error))?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| HostError::db("failed to configure SQLite durability", error))?;
        connection
            .pragma_update(None, "temp_store", "MEMORY")
            .map_err(|error| {
                HostError::db("failed to configure SQLite temporary storage", error)
            })?;

        migrate_database(&mut connection, &backup_directory)?;
        Ok(Self {
            connection,
            #[cfg(test)]
            database_backup_directory: backup_directory,
        })
    }

    pub fn load_document(&self) -> HostResult<Option<Value>> {
        let document = self
            .connection
            .query_row(
                "SELECT document_json FROM granite_state WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| HostError::db("failed to read application state", error))?;
        match document {
            Some(document) => serde_json::from_str(&document).map(Some).map_err(|error| {
                HostError::json("stored application state is invalid JSON", error)
            }),
            None => Ok(None),
        }
    }

    pub fn save_document(&mut self, state: &Value) -> HostResult<()> {
        if !state.is_object() {
            return Err(HostError::InvalidArgs(
                "state.save requires a JSON object".into(),
            ));
        }
        let schema_version = state
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                HostError::InvalidArgs("state.save requires an integer schemaVersion field".into())
            })?;
        if schema_version < 0 {
            return Err(HostError::InvalidArgs(
                "schemaVersion cannot be negative".into(),
            ));
        }
        let document = serde_json::to_string(state)
            .map_err(|error| HostError::json("failed to serialize application state", error))?;
        if document.len() > MAX_STATE_DOCUMENT_BYTES {
            return Err(HostError::Unsupported(format!(
                "application state is {} bytes; the SQLite state document limit is {MAX_STATE_DOCUMENT_BYTES} bytes",
                document.len()
            )));
        }

        let transaction = self
            .connection
            .transaction()
            .map_err(|error| HostError::db("failed to begin state transaction", error))?;
        let previous = transaction
            .query_row(
                "SELECT schema_version, document_json FROM granite_state WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| {
                HostError::db("failed to inspect previous application state", error)
            })?;
        if let Some((previous_version, previous_document)) = previous {
            if previous_version != schema_version {
                transaction
                    .execute(
                        "INSERT INTO granite_state_backups
                            (schema_version, document_json, reason, created_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![
                            previous_version,
                            previous_document,
                            format!("state schema {previous_version} -> {schema_version}"),
                            now_rfc3339()
                        ],
                    )
                    .map_err(|error| {
                        HostError::db("failed to back up state before schema change", error)
                    })?;
            }
        }
        transaction
            .execute(
                "INSERT INTO granite_state (singleton, schema_version, document_json, updated_at)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(singleton) DO UPDATE SET
                   schema_version = excluded.schema_version,
                   document_json = excluded.document_json,
                   updated_at = excluded.updated_at",
                params![schema_version, document, now_rfc3339()],
            )
            .map_err(|error| HostError::db("failed to write application state", error))?;
        transaction
            .execute(
                "DELETE FROM granite_state_backups
                 WHERE id NOT IN (
                   SELECT id FROM granite_state_backups ORDER BY id DESC LIMIT 20
                 )",
                [],
            )
            .map_err(|error| HostError::db("failed to prune state backups", error))?;
        transaction
            .commit()
            .map_err(|error| HostError::db("failed to commit application state", error))
    }

    pub fn schema_version(&self) -> HostResult<i64> {
        self.connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| HostError::db("failed to read database schema version", error))
    }

    #[cfg(test)]
    pub fn backup_count(&self) -> HostResult<usize> {
        let count: i64 = self
            .connection
            .query_row("SELECT COUNT(*) FROM granite_state_backups", [], |row| {
                row.get(0)
            })
            .map_err(|error| HostError::db("failed to count state backups", error))?;
        Ok(count as usize)
    }

    #[cfg(test)]
    pub fn database_backup_directory(&self) -> &Path {
        &self.database_backup_directory
    }
}

fn migrate_database(connection: &mut Connection, backup_directory: &Path) -> HostResult<()> {
    let current: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| HostError::db("failed to read SQLite schema version", error))?;
    if current > CURRENT_DATABASE_VERSION {
        return Err(HostError::Unsupported(format!(
            "database schema {current} is newer than this host supports ({CURRENT_DATABASE_VERSION})"
        )));
    }
    if current > 0 && current < CURRENT_DATABASE_VERSION {
        create_database_backup(connection, backup_directory, current)?;
    }
    if current == CURRENT_DATABASE_VERSION {
        return Ok(());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| HostError::db("failed to begin SQLite migration", error))?;
    if current < 1 {
        transaction
            .execute_batch(
                "CREATE TABLE granite_state (
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                   schema_version INTEGER NOT NULL,
                   document_json TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE granite_state_backups (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   schema_version INTEGER NOT NULL,
                   document_json TEXT NOT NULL,
                   reason TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );",
            )
            .map_err(|error| HostError::db("failed to initialize SQLite schema", error))?;
    }
    if current < 2 {
        transaction
            .execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_granite_state_backups_created_at
                   ON granite_state_backups(created_at);",
            )
            .map_err(|error| HostError::db("failed to apply SQLite schema migration", error))?;
    }
    transaction
        .pragma_update(None, "user_version", CURRENT_DATABASE_VERSION)
        .map_err(|error| HostError::db("failed to record SQLite schema version", error))?;
    transaction
        .commit()
        .map_err(|error| HostError::db("failed to commit SQLite migration", error))
}

fn create_database_backup(
    connection: &Connection,
    backup_directory: &Path,
    schema_version: i64,
) -> HostResult<PathBuf> {
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let destination = backup_directory.join(format!(
        "granite-v{schema_version}-{timestamp}-{}.sqlite3",
        Uuid::new_v4()
    ));
    let destination_text = destination.to_string_lossy().into_owned();
    connection
        .execute("VACUUM INTO ?1", params![destination_text])
        .map_err(|error| HostError::db("failed to create database migration backup", error))?;
    if !destination.is_file() {
        return Err(HostError::Storage(
            "database migration backup was not created".into(),
        ));
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn state_round_trips_in_private_sqlite() {
        let directory = tempdir().expect("app data");
        let mut database = Database::open(directory.path()).expect("open database");
        assert_eq!(database.load_document().expect("empty load"), None);
        let state = json!({"schemaVersion": 1, "notes": [{"id": "note-1"}]});
        database.save_document(&state).expect("save state");
        assert_eq!(database.load_document().expect("load"), Some(state));
        assert_eq!(database.schema_version().expect("schema"), 2);
    }

    #[test]
    fn state_schema_changes_keep_a_verified_backup_row() {
        let directory = tempdir().expect("app data");
        let mut database = Database::open(directory.path()).expect("open database");
        database
            .save_document(&json!({"schemaVersion": 1, "books": []}))
            .expect("save v1");
        database
            .save_document(&json!({"schemaVersion": 2, "books": []}))
            .expect("save v2");
        assert_eq!(database.backup_count().expect("backup count"), 1);
    }

    #[test]
    fn database_schema_migration_creates_a_file_backup() {
        let directory = tempdir().expect("app data");
        let path = directory.path().join("granite.sqlite3");
        let connection = Connection::open(&path).expect("legacy database");
        connection
            .execute_batch(
                "CREATE TABLE granite_state (
                   singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                   schema_version INTEGER NOT NULL,
                   document_json TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE granite_state_backups (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   schema_version INTEGER NOT NULL,
                   document_json TEXT NOT NULL,
                   reason TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 PRAGMA user_version = 1;",
            )
            .expect("legacy schema");
        drop(connection);

        let database = Database::open(directory.path()).expect("migrate database");
        let backups: Vec<_> = fs::read_dir(database.database_backup_directory())
            .expect("read backups")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(database.schema_version().expect("schema"), 2);
    }

    #[test]
    fn rejects_objects_without_a_schema_version() {
        let directory = tempdir().expect("app data");
        let mut database = Database::open(directory.path()).expect("open database");
        assert!(database.save_document(&json!({"books": []})).is_err());
    }
}
