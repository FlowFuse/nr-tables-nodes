'use strict';

/**
 * Return an incoming node ID if the node has any input wired to it, false otherwise.
 * If filter callback is not null, then this function filters incoming nodes.
 * @param {Object} toNode
 * @param {function} filter
 * @return {(number|boolean)}
 */
function findInputNodeId(toNode, filter = null) {
	if (toNode && toNode._flow && toNode._flow.global) {
		const allNodes = toNode._flow.global.allNodes;
		for (const fromNodeId of Object.keys(allNodes)) {
			const fromNode = allNodes[fromNodeId];
			if (fromNode && fromNode.wires) {
				for (const wireId of Object.keys(fromNode.wires)) {
					const wire = fromNode.wires[wireId];
					for (const toNodeId of wire) {
						if (toNode.id === toNodeId && (!filter || filter(fromNode))) {
							return fromNode.id;
						}
					}
				}
			}
		}
	}
	return false;
}

module.exports = function (RED) {
	const Mustache = require('mustache');
	const Cursor = require('pg-cursor');
	const { Pool } = require('pg');
	const named = require('../node-postgres-named.js');
	const ffAPI = require('./utils/ff-api.js');

	// are we running on FlowFuse?
	const ffHost = RED.settings.flowforge?.forgeURL || null;
	const ffTeamId = RED.settings.flowforge?.teamID || null;
	const ffTablesToken = RED.settings.flowforge?.tables?.token || null;

	function QueryNode(config) {
		const node = this;
		RED.nodes.createNode(node, config);
		node.topic = config.topic;
		node.query = config.query;
		node.split = config.split;
		node.rowsPerMsg = config.rowsPerMsg;

		node.pgPool = {
			totalCount: 0
		};

		// Declare the ability of this node to provide ticks upstream for back-pressure
		node.tickProvider = true;
		let tickUpstreamId;
		let tickUpstreamNode;

		// Declare the ability of this node to consume ticks from downstream for back-pressure
		node.tickConsumer = true;
		let downstreamReady = true;

		// For streaming from PostgreSQL
		let cursor;
		let getNextRows;

		// Do not update status faster than x ms
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
			try {
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
							text: 'No Databases',
						});
					}
				});
			} catch (err) {
				console.error('Error getting FlowFuse Tables', err);
			}
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

			if (tickUpstreamId === undefined) {
				// TODO: Test with older versions of Node-RED:
				tickUpstreamId = findInputNodeId(node, (n) => n && n.tickConsumer);
				tickUpstreamNode = tickUpstreamId ? RED.nodes.getNode(tickUpstreamId) : null;
			}

			if (msg.tick) {
				downstreamReady = true;
				if (getNextRows) {
					getNextRows();
				}
			} else {
				const partsId = Math.random();
				let query = msg.query ? msg.query : Mustache.render(node.query, { msg });

				let client = null;

				const handleDone = async (isError = false) => {
					if (cursor) {
						cursor.close();
						cursor = null;
					}
					if (client) {
						if (client.release) {
							client.release(isError);
						} else if (client.end) {
							await client.end();
						}
						client = null;
						updateStatus(-1, isError);
					} else if (isError) {
						updateStatus(-1, isError);
					}
					getNextRows = null;
				};

				const handleError = (err) => {
					const error = (err ? err.toString() : 'Unknown error!') + ' ' + query;
					handleDone(true);
					msg.payload = error;
					msg.parts = {
						id: partsId,
						abort: true,
					};
					downstreamReady = false;
					if (err) {
						if (done) {
							// Node-RED 1.0+
							done(err);
						} else {
							// Node-RED 0.x
							node.error(err, msg);
						}
					}
				};

				handleDone();
				updateStatus(+1);
				downstreamReady = true;

				if (node.pgPool && node.pgPool.connect) {
					try {
						// connect to the database
						client = await node.pgPool.connect();

						let params = [];
						if (msg.params && msg.params.length > 0) {
							params = msg.params;
						} else if (msg.queryParameters && (typeof msg.queryParameters === 'object')) {
							({ text: query, values: params } = named.convert(query, msg.queryParameters));
						}

						if (node.split) {
							let partsIndex = 0;
							delete msg.complete;

							cursor = client.query(new Cursor(query, params));

							const cursorCallback = (err, rows, result) => {
								if (err) {
									handleError(err);
								} else {
									const complete = rows.length < node.rowsPerMsg;
									if (complete) {
										handleDone(false);
									}
									const msg2 = Object.assign({}, msg, {
										payload: (node.rowsPerMsg || 1) > 1 ? rows : rows[0],
										pgsql: {
											command: result.command,
											rowCount: result.rowCount,
										},
										parts: {
											id: partsId,
											type: 'array',
											index: partsIndex,
										},
									});
									if (msg.parts) {
										msg2.parts.parts = msg.parts;
									}
									if (complete) {
										msg2.parts.count = partsIndex + 1;
										msg2.complete = true;
									}
									partsIndex++;
									if (node.enableBackPressure) {
										// await msg.tick before sending further messages
										downstreamReady = false;
									} else {
										// send all of the messages as quick as possible
										downstreamReady = true;
									}
									if (msg2.complete) {
										send([null, msg2]);
									} else {
										send([msg2, null]);
									}
									if (complete) {
										if (tickUpstreamNode) {
											tickUpstreamNode.receive({ tick: true });
										}
										if (done) {
											done();
										}
									} else {
										getNextRows();
									}
								}
							};

							getNextRows = () => {
								if (downstreamReady) {
									cursor.read(node.rowsPerMsg || 1, cursorCallback);
								}
							};
						} else {
							getNextRows = async () => {
								try {
									const result = await client.query(query, params);
									if (result.length) {
										// Multiple queries
										msg.payload = [];
										msg.pgsql = [];
										for (const r of result) {
											msg.payload = msg.payload.concat(r.rows);
											msg.pgsql.push({
												command: r.command,
												rowCount: r.rowCount,
												rows: r.rows,
											});
										}
									} else {
										msg.payload = result.rows;
										msg.pgsql = {
											command: result.command,
											rowCount: result.rowCount,
										};
									}

									handleDone();
									downstreamReady = false;
									send(msg);
									if (tickUpstreamNode) {
										tickUpstreamNode.receive({ tick: true });
									}
									if (done) {
										done();
									}
								} catch (ex) {
									handleError(ex);
								}
							};
						}

						getNextRows();
					} catch (err) {
						handleError(err);
					}
				} else {
					// User has not setup a database in FlowFuse yet
					node.error('No database found. Please setup a database in FlowFuse Tables.');
				}
			}
		});
	}

	if (ffHost) {
		RED.nodes.registerType('tables-query', QueryNode);
	} else {
		// report as warning that the node is not configured
		RED.log.warn('@flowfuse/tables-query: This node can only be used in Node-RED Instances running with FlowFuse');
	}
};
