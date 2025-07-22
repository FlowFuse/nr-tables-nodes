const { Pool } = require('pg');

function getField(node, kind, value) {
	switch (kind) {
		case 'flow':	// Legacy
			return node.context().flow.get(value);
		case 'global':
			return node.context().global.get(value);
		case 'num':
			return parseInt(value);
		case 'bool':
		case 'json':
			return JSON.parse(value);
		case 'env':
			return process.env[value];
		default:
			return value;
	}
}

module.exports = function (RED) {
	function QueryConfigNode(n) {
		const node = this;
		RED.nodes.createNode(node, n);
		node.name = n.name;
		node.host = n.host;
		node.hostFieldType = n.hostFieldType;
		node.port = n.port;
		node.portFieldType = n.portFieldType;
		node.database = n.database;
		node.databaseFieldType = n.databaseFieldType;
		node.ssl = n.ssl;
		node.sslFieldType = n.sslFieldType;
		node.applicationName = n.applicationName;
		node.applicationNameType = n.applicationNameType;
		node.max = n.max;
		node.maxFieldType = n.maxFieldType;
		node.idle = n.idle;
		node.idleFieldType = n.idleFieldType;
		node.user = n.user;
		node.userFieldType = n.userFieldType;
		node.password = n.password;
		node.passwordFieldType = n.passwordFieldType;
		node.connectionTimeout = n.connectionTimeout;
		node.connectionTimeoutFieldType = n.connectionTimeoutFieldType;

		this.pgPool = new Pool({
			user: getField(node, n.userFieldType, n.user),
			password: getField(node, n.passwordFieldType, n.password),
			host: getField(node, n.hostFieldType, n.host),
			port: getField(node, n.portFieldType, n.port),
			database: getField(node, n.databaseFieldType, n.database),
			ssl: getField(node, n.sslFieldType, n.ssl),
			application_name: getField(node, n.applicationNameType, n.applicationName),
			max: getField(node, n.maxFieldType, n.max),
			idleTimeoutMillis: getField(node, n.idleFieldType, n.idle),
			connectionTimeoutMillis: getField(node, n.connectionTimeoutFieldType, n.connectionTimeout),
		});
		this.pgPool.on('error', (err, _) => {
			node.error(err.message);
		});
	}

	RED.nodes.registerType('tables-query-config', QueryConfigNode);
};
