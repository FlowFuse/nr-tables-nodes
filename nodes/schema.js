'use strict';

module.exports = function (RED) {
	const { Pool } = require('pg');
	const ffAPI = require('./utils/ff-api.js');
	const { columnsQuery, pksQuery, fksQuery, indexesQuery, commentsQuery, generatePostgreSqlDdl } = require('./utils/table-hints.js');

	// are we running on FlowFuse?
	const ffHost = RED.settings.flowforge?.forgeURL || null;
	const ffTeamId = RED.settings.flowforge?.teamID || null;
	const ffTablesToken = RED.settings.flowforge?.tables?.token || null;

	function SchemaNode(config) {
		const node = this;
		RED.nodes.createNode(node, config);

		const updateStatusPeriodMs = 1000;
		let nbQueue = 0;
		let hasError = false;
		let statusTimer = null;
		const updateStatus = (incQueue = 0, isError = false) => {
			nbQueue += incQueue;
			hasError |= isError;
			if (!statusTimer) {
				statusTimer = setTimeout(() => {
					let fill = 'grey';
					if (hasError) {
						fill = 'red';
					} else if (nbQueue <= 0) {
						fill = 'blue';
					} else if (nbQueue <= node.pgPool.totalCount) {
						fill = 'green';
					} else {
						fill = 'yellow';
					}
					node.status({
						fill: fill,
						shape: hasError || nbQueue > node.pgPool.totalCount ? 'ring' : 'dot',
						text: 'Queue: ' + nbQueue + (hasError ? ' Error!' : ''),
					});
					hasError = false;
					statusTimer = null;
				}, updateStatusPeriodMs);
			}
		};

		if (ffTablesToken) {
			ffAPI.getDatabases(ffHost, ffTeamId, ffTablesToken).then((databases) => {
				if (databases.length > 0) {
					const creds = databases[0].credentials;
					node.pgPool = new Pool({
						user: creds.user,
						password: creds.password,
						host: creds.host,
						port: creds.port,
						database: creds.database,
						ssl: creds.ssl
					});
					updateStatus(0, false);
				} else {
					node.warn('No databases found in FlowFuse Tables for your team.');
					node.status({
						fill: 'red',
						shape: 'ring',
						text: 'No Databases'
					});
				}
			}).catch(err => {
				node.error(err);
				node.status({
					fill: 'red',
					shape: 'ring',
					text: 'error'
				});
			});
		} else {
			node.status({
				fill: 'red',
				shape: 'ring',
				text: 'Not Available',
			});
			node.warn('FlowFuse Tables is not available to this Instance. You may need to upgrade your Instance, or upgrade your Team to a higher plan.');
		}

		node.on('input', async (msg, send, done) => {
			// 'send' and 'done' require Node-RED 1.0+
			send = send || function () { node.send.apply(node, arguments); };
			let client = null;
			try {
				if (node.pgPool && node.pgPool.connect) {
					client = await node.pgPool.connect();
					const columns = await client.query(columnsQuery);
					const pks = await client.query(pksQuery);
					const fks = await client.query(fksQuery);
					const indexes = await client.query(indexesQuery);
					const comments = await client.query(commentsQuery);

					const ddl = generatePostgreSqlDdl(columns.rows, pks.rows, fks.rows, indexes.rows, comments.rows);
					msg.payload = ddl;
					send(msg);
					if (done) {
						done();
					}
					if (client) {
						if (client.release) {
							client.release();
						} else if (client.end) {
							await client.end();
						}
					}
				}
			} catch (err) {
				if (client) {
					if (client.release) {
						client.release();
					} else if (client.end) {
						await client.end();
					}
				}
			}
		});
	}

	if (ffHost) {
		RED.nodes.registerType('tables-schema', SchemaNode);
	} else {
		// report as warning that the node is not configured
		RED.log.warn('@flowfuse/tables-schema: This node can only be used in Node-RED Instances running with FlowFuse');
	}
};
