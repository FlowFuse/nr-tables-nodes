# FlowFuse Tables: Node-RED Nodes

This repository contains a set of Node-RED nodes for use with the FlowFuse Tables offering, allowing developers to write and run queries against database tables inside FlowFuse Tables.

## Nodes

### Query

This node allows you to write and run queries against database tables that are managed by FlowFuse Tables.

## Outputs

The response (rows) is provided in `msg.payload` as an array.

An exception is if the *Split results* option is enabled and the *Number of rows per message* is set to **1**,
then `msg.payload` is not an array but the single-row response.

Additional information is provided as `msg.pgsql.rowCount` and `msg.pgsql.command`.
See the [underlying documentation](https://node-postgres.com/apis/result) for details.

In the case of multiple queries, then `msg.pgsql` is an array.

## Inputs

### SQL query template

This node uses the [Mustache template system](https://github.com/janl/mustache.js) to generate queries based on the message:

```sql
-- INTEGER id column
SELECT * FROM table WHERE id = {{{ msg.id }}};

-- TEXT id column
SELECT * FROM table WHERE id = '{{{ msg.id }}}';
```

### Dynamic SQL queries

As an alternative to using the query template above, this node also accepts an SQL query via the `msg.query` parameter.

### Parameterized query (numeric)

Parameters for parameterized queries can be passed as a parameter array `msg.params`:

```js
// In a function, provide parameters for the parameterized query
msg.params = [ msg.id ];
return msg;
```

```sql
-- In this node, use a parameterized query, in this example reading the 1st parameter
SELECT * FROM table WHERE id = $1;
```

### Named parameterized query

As an alternative to numeric parameters, named parameters for parameterized queries can be passed as a parameter object in `msg.queryParameters`:

```js
// In a function, provide parameters for the named parameterized query
msg.queryParameters.id = msg.id;
return msg;
```

```sql
-- In this node, use a named parameterized query, in this example reading the "id" parameter
SELECT * FROM table WHERE id = $id;
```

*Note*: named parameters are not natively supported by PostgreSQL, and this library just emulates them,
so this is less robust than numeric parameters.

### DDL output

Passing an input message with `ddl` set to `true` will cause the node to output the DDL for the connected database.

```js
msg.ddl = true;
return msg;
```

NOTE: The DDL is intended to be a reference only. It is not guaranteed to be 100% complete, accurate or executable.

## Installation

### Running on FlowFuse

In order to run these nodes, you will need to have a Team, with the Tables feature enabled, running on FlowFuse.

This can be FlowFuse Cloud, Self-Hosted or Dedicated, but FlowFuse itself will require a paid-for license in order to use the Tables feature.

#### FlowFuse Cloud

All Hosted Instances on FlowFuse Cloud will have the "query" node pre-installed. If, for any reason, it is not, you can go to the "Manage Palette" menu, and select the "Install" tab in the palette, searching for `@flowfuse/nr-tables-nodes`.


## Backpressure

This node supports *backpressure* / *flow control*:
when the *Split results* option is enabled, it waits for a *tick* before releasing the next batch of lines,
to make sure the rest of your Node-RED flow is ready to process more data
(instead of risking an out-of-memory condition), and also conveys this information upstream.

So when the *Split results* option is enabled, this node will only output one message at first,
and then awaits a message containing a truthy `msg.tick` before releasing the next message.

To make this behaviour potentially automatic (avoiding manual wires), this node declares its ability by exposing a truthy `node.tickConsumer`
for downstream nodes to detect this feature, and a truthy `node.tickProvider` for upstream nodes.
Likewise, this node detects upstream nodes using the same back-pressure convention, and automatically sends ticks.


## Sequences for split results

When the *Split results* option is enabled (streaming), the messages contain some information following the
conventions for [*messages sequences*](https://nodered.org/docs/user-guide/messages#message-sequences).

```js
{
  payload: '...',
  parts: {
    id: 0.1234, // sequence ID, randomly generated (changes for every sequence)
    index: 5, // incremented for each message of the same sequence
    count: 6, // total number of messages; only available in the last message of a sequence
    parts: {}, // optional upstream parts information
  },
  complete: true, // True only for the last message of a sequence
}
```

## Credits

This set of nodes originally started as a fork of [node-red-contrib-postgresql](https://github.com/alexandrainst/node-red-contrib-postgresql).

## Release process

In this project, the [Release Please](https://github.com/googleapis/release-please) is used to automatically determine the next release version based on the commit messages in the codebase. 

By using the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), the project adheres to a standardized format for commit messages, which `Release Please` uses to determine whether the next release should be a major, minor, or patch release.

### Components

1. The `Prepare release` GitHub Action workflow:

    * A Release Please action that analyzes commit messages to determine the type of release required (major, minor, patch) based on the Conventional Commits specification
    * Creates a pre-release pull request with the proposed version bump and changelog
    * Once merged, automatically updates the version number in `package.json` and creates a new release on GitHub with the appropriate changelog

2. The `Lint Pull Request Title` GitHub Action workflow:

    * A workflow that runs on pull request creation and uses the `amannn/action-semantic-pull-request` action to validate that pull request titles follow the Conventional Commits format
    * Together with adjusted default merge commit message, this ensures that all commits merged into the main branch adhere to the expected format, allowing Release Please to function correctly


### Pull Request Title Format

The Conventional Commits preset expects pull request titles to be in the following format:

```
<type>(<scope>): <subject>
```

* Type: Describes the category of the commit. Examples include:
    * `feat`: A new feature (triggers a minor version bump).
    * `fix`: A bug fix (triggers a patch version bump).
    * `perf`: A code change that improves performance (triggers a patch version bump).
    * `refactor`: A code change that neither fixes a bug nor adds a feature (does not trigger a release unless it's accompanied by a BREAKING CHANGE).
    * `docs`: Documentation-only changes (does not trigger a release).
    * `chore`: Changes to the build process or auxiliary tools and libraries (does not trigger a release).
* Scope: An optional part that provides additional context about what was changed (e.g., module, component).
* Subject: A brief description of the changes.

### Handling Breaking Changes

To indicate a breaking change, the exclamation mark `!` should be used immediately after the type/scope:

* `feat!:,` 
* `fix!:`
* `refactor!:`
