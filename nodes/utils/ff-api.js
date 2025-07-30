const getDatabases = async (host, teamId, token) => {
	const response = await fetch(`${host}/api/v1/teams/${teamId}/databases`,
		{
			headers: {
				'Authorization': `Bearer ${token}`
			}
		}
	);
	const data = await response.json();
	return data;
};

module.exports = {
	getDatabases: getDatabases
};
