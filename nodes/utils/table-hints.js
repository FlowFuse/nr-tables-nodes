const pg = require('pg');

const columnsQuery = `
        SELECT
            c.table_schema,
            c.table_name,
            c.column_name,
            c.data_type,
            c.udt_name,
            c.character_maximum_length,
            c.is_nullable,
            c.column_default,
            t.table_type -- This will be 'BASE TABLE' or 'VIEW'
        FROM
            information_schema.columns AS c
        JOIN
            information_schema.tables AS t
        ON
            c.table_schema = t.table_schema
            AND c.table_name = t.table_name
        WHERE
            c.table_schema != 'pg_catalog'
            AND c.table_schema != 'information_schema'
        ORDER BY
            c.table_name,
            c.ordinal_position;
    `;

const pksQuery = `
        SELECT
            tc.table_schema,
            kcu.table_name,
            kcu.column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        WHERE
            tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema != 'pg_catalog'
            AND tc.table_schema != 'information_schema';
    `;

const fksQuery = `
        SELECT
            tc.table_schema as from_schema,
            tc.table_name AS from_table,
            kcu.column_name AS from_column,
            ccu.table_schema AS to_schema,
            ccu.table_name AS to_table,
            ccu.column_name AS to_column
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        WHERE
            tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema != 'pg_catalog'
            AND tc.table_schema != 'information_schema';
    `;

const indexesQuery = `
        SELECT
            n.nspname AS schema_name,
            t.relname AS table_name,
            i.relname AS index_name,
            to_json(array_agg(a.attname)) AS column_names
        FROM
            pg_class t,
            pg_class i,
            pg_index ix,
            pg_attribute a,
            pg_namespace n
        WHERE
            t.oid = ix.indrelid
            AND i.oid = ix.indexrelid
            AND a.attrelid = t.oid
            AND a.attnum = ANY(ix.indkey)
            AND t.relnamespace = n.oid
            AND ix.indisprimary = false -- skip prim key index as they will be retrieved in the columns query
            AND n.nspname != 'pg_catalog'
            AND n.nspname != 'information_schema'
        GROUP BY
            n.nspname,
            t.relname,
            i.relname
        ORDER BY
            n.nspname,
            t.relname,
            i.relname;
    `;

const commentsQuery = `
        SELECT
            n.nspname AS schema_name,
            c.relname AS table_name,
            a.attname AS column_name,
            d.description AS column_comment
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        JOIN pg_catalog.pg_description d ON d.objoid = a.attrelid AND d.objsubid = a.attnum
        WHERE
            n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND c.relkind IN ('r', 'v') -- 'r' for tables, 'v' for views
            AND a.attnum > 0 -- Exclude system columns
        ORDER BY
            schema_name,
            table_name,
            column_name;
    `;

function generatePostgreSqlDdl(columns, pks, fks, indexes, comments) {
	const schemaMap = new Map();

	// Step 1: Populate the schema with tables and columns.
	// NOTE: This will also include views and they will appear to be tables with columns and types.
	// This simplifies and minimises the DDL, more importantly, it provides better context for the AI.
	columns.forEach(row => {
		if (!schemaMap.has(row.table_schema)) {
			schemaMap.set(row.table_schema, {
				schemaName: row.table_schema,
				tableMap: new Map(),
				viewMap: new Map()
			});
		}

		const schema = schemaMap.get(row.table_schema);
		if (!schema.tableMap.has(row.table_name)) {
			schema.tableMap.set(row.table_name, {
				isView: row.table_type === 'VIEW',
				tableName: row.table_name,
				columns: [],
				primaryKeys: [],
				foreignKeys: [],
				indexes: []
			});
		}
		const table = schema.tableMap.get(row.table_name);
		const comment = comments.find(c => c.table_name === row.table_name && c.schema_name === row.table_schema && c.column_name === row.column_name);
		const col = {
			columnName: row.column_name,
			dataType: row.udt_name,
			isNullable: row.is_nullable === 'YES',
			defaultValue: row.column_default,
			comment: comment ? comment.column_comment : ''
		};
		if (col.dataType === 'varchar' && row.character_maximum_length) {
			col.dataType = `${col.dataType}(${row.character_maximum_length})`;
		} else if (col.dataType === 'int8' && /nextval(.*::regclass)/.test(col.defaultValue)) {
			col.dataType = 'bigserial';
			col.defaultValue = '';
		} else if (col.dataType === 'int4' && /nextval(.*::regclass)/.test(col.defaultValue)) {
			col.dataType = 'serial4';
			col.defaultValue = '';
		}
		table.columns.push(col);
	});

	// Step 2: Add primary key information.
	pks.forEach(row => {
		const schema = schemaMap.get(row.table_schema);
		if (!schema) return;
		const table = schema.tableMap.get(row.table_name);
		if (table) {
			// Add the column name to the primaryKeys array for the table.
			table.primaryKeys.push(row.column_name);

			// Find the specific column and mark it as a primary key.
			const column = table.columns.find(c => c.columnName === row.column_name);
			if (column) {
				column.isPrimaryKey = true;
			}
		}
	});

	// Step 3: Add foreign key information.
	fks.forEach(row => {
		const schema = schemaMap.get(row.from_schema);
		if (!schema) return;
		const table = schema.tableMap.get(row.from_table);
		if (table) {
			// Find the specific column and add its FK details.
			const column = table.columns.find(c => c.columnName === row.from_column);
			if (column) {
				column.isForeignKey = true;
				column.references = {
					table: row.to_table,
					column: row.to_column
				};
			}
		}
	});

	// Step 4: Add index information.
	indexes.forEach(row => {
		const schema = schemaMap.get(row.schema_name);
		if (!schema) return;
		const table = schema.tableMap.get(row.table_name);
		if (table) {
			table.indexes.push({
				indexName: row.index_name,
				columnNames: row.column_names // should be an array of strings
			});
		}
	});

	// Convert the Map values back to an array for the final output.
	const schemas = Array.from(schemaMap.values());

	const ddlTC = [];
	const ddlFK = [];
	const ddlIdx = [];
	const ddlViews = []; // Views
	const ei = pg.escapeIdentifier;
	const el = pg.escapeLiteral;
	schemas.forEach(schema => {
		const schemaName = ei(schema.schemaName);
		ddlTC.push(`-- PostgreSQL Schema: ${schemaName}`);
		const tables = Array.from(schema.tableMap.values());
		tables.forEach(table => {
			const tableName = ei(table.tableName);
			const tableNameFull = `${schemaName}.${tableName}`;
			// generate CREATE TABLE statements with columns, types and PKs.
			const columns = table.columns.map(col => {
				let columnDef = `${ei(col.columnName)} ${col.dataType}`;
				if (!col.isNullable || col.isPrimaryKey) {
					columnDef += ' NOT NULL';
				}
				if (col.defaultValue) {
					columnDef += ` DEFAULT ${col.defaultValue}`;
				}
				return columnDef;
			});

			// Add primary key constraint at the end of the column list.
			if (table.primaryKeys.length > 0) {
				const tableNamePK = ei(table.tableName + '_pkey');
				const escapedPrimaryKeys = table.primaryKeys.map(pk => {
					if (pk && pk.startsWith('"') && pk.endsWith('"')) {
						return pk;
					}
					return ei(pk);
				});
				const pkDef = `CONSTRAINT ${tableNamePK} PRIMARY KEY (${escapedPrimaryKeys.join(',')})`;
				columns.push(pkDef);
			}

			const ddlObj = table.isView ? ddlViews : ddlTC;
			if (table.isView) {
				// The definition for a VIEW is not included as it may be complex.
				// Instead, the columns and their types are shown to help provide context to the AI
				ddlObj.push(`-- NOTE: Below, ${tableNameFull} is a VIEW in the DB, it is shown as a regular table for context only.`);
			}

			ddlObj.push(`CREATE TABLE ${tableNameFull} (\n\t${columns.join(',\n\t')}\n);`);
			table.columns.forEach(c => {
				if (c.comment) {
					ddlObj.push(`COMMENT ON COLUMN ${tableNameFull}.${ei(c.columnName)} IS ${el(c.comment)};`);
				}
			});

			// generate foreign key constraints.
			table.foreignKeys.forEach(fk => {
				const fkKeyName = ei(`${table.tableName}_${fk.columnName}_fkey`);
				const fkColName = ei(fk.columnName);
				ddlFK.push(`ALTER TABLE ${schemaName}.${tableName} ADD CONSTRAINT ${fkKeyName} FOREIGN KEY (${fkColName})` +
					` REFERENCES ${schemaName}.${ei(fk.references.table)}(${ei(fk.references.column)});`);
			});

			// generate CREATE INDEX statements.
			table.indexes.forEach(index => {
				if (index?.indexName && Array.isArray(index?.columnNames) && index.columnNames.length > 0) {
					const columnNames = index.columnNames.map(ei).join(',');
					ddlIdx.push(`CREATE INDEX ${ei(index.indexName)} ON ${schemaName}.${tableName} (${columnNames});`);
				}
			});
		});
	});
	return ddlTC.concat(ddlViews).concat(ddlFK).concat(ddlIdx).join('\n');
};

module.exports = {
	columnsQuery,
	pksQuery,
	fksQuery,
	indexesQuery,
	commentsQuery,
	generatePostgreSqlDdl
};
