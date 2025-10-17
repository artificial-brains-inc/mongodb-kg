> **Status:** Experimental – actively evolving.  
> Feedback, issues, and pull requests are welcome.


# MongoDB KG

A generic Knowledge Graph SDK for Mongoose. It lets you turn any MongoDB collection into a knowledge graph where documents become nodes and relationships become edges.
The SDK wires itself into your Mongoose models through middleware so the graph stays in sync as your data changes.

---

## Features

* Schema-agnostic: works with any model; you provide simple mapping functions.
* Idempotent upserts: deterministic IDs prevent duplicate nodes or edges.
* Automatic syncing: changes to your documents are reflected automatically.
* Bulk resync: rebuilds the graph from existing collections using your bindings.
* Minimal API: `kgInit`, `createGraphModels`, `bindModel`, `kgBulkSync`.

---

## Installation

```bash
npm install mongoose
npm install ./mongodb-kg
```

Mongoose is a peer dependency; bring your own compatible version.

---

## Quick Start

This example uses the **mflix** dataset.
We create nodes for `movies`, `users`, and `comments`, and edges linking commenters to the movies they comment on.

### 1. Initialize the SDK

Tell the SDK which Mongoose models will store your nodes and edges.

```js
const mongoose = require('mongoose');
const { kgInit } = require('mongodb-kg');

const NodesModel = require('./models/nodes');
const EdgesModel = require('./models/edges');

const MflixMovie   = require('./models/movies');
const MflixUser    = require('./models/users');
const MflixComment = require('./models/comments');

kgInit({
  nodesModel: NodesModel,
  edgesModel: EdgesModel,
  repos: { MflixMovie, MflixUser, MflixComment } // optional
});
```

---

### 1a. Auto-create Graph Models (optional)

You can automatically generate `NodeModel` and `EdgeModel` using `createGraphModels()`. Be aware to index customFields as required to make it efficient (it will be indexed as properties.field). 

```js
const { createGraphModels, kgInit } = require('mongodb-kg');

const nodeTypes = ['user', 'movie', 'comment', 'theater'];
const relationships = ['commented_on', 'screened_at'];

const { NodeModel, EdgeModel } = createGraphModels({
  node: {
    name: 'NodesKG',
    customFields: {
      title: { type: String, index: true },
      year:  { type: String, index: true },
      name:  { type: String, index: true }
    },
    typeEnum: nodeTypes
  },
  edge: {
    name: 'EdgesKG',
    customFields: {
      text: { type: String }
    },
    relationshipEnum: relationships
  },
  connection: mongoose
});

kgInit({ nodesModel: NodeModel, edgesModel: EdgeModel });
```

Nodes always include:
`id`, `label`, `type`, `source_collection`, `source_id`.

Edges always include:
`id`, `source`, `target`.

---

### 2. Bind Your Models

`bindModel()` defines how a document becomes a node and which edges it emits.
The SDK attaches middleware to each bound Mongoose model.

```js
const { bindModel } = require('mongodb-kg');

// Movies → nodes
bindModel(MflixMovie, {
  node: (m) => ({
    id: `movie-${m._id}`,
    label: m.title || 'Untitled Movie',
    type: 'movie',
    source_collection: 'movies',
    source_id: m._id,
    properties: { year: m.year, title: m.title, plot: m.plot }
  }),
  cleanup: (m) => [
    { source: `movie-${m._id}` },
    { target: `movie-${m._id}` }
  ]
});

// Comments → commenter node + edge commenter → movie
bindModel(MflixComment, {
  node: (c) => ({
    id: `user-${c._id}`,
    label: c.name || 'Commenter',
    type: 'person',
    source_collection: 'comments',
    source_id: c._id,
    properties: { text: c.text }
  }),
  edges: (c) => {
    const commenter = `user-${c._id}`;
    const movie = `movie-${c.movie_id}`;
    return [{
      id: `${commenter}_commented_on_${movie}`,
      source: commenter,
      target: movie,
      relationship: 'commented_on',
      weight: 1,
      properties: { date: c.date }
    }];
  },
  cleanup: (c) => [{ source: `user-${c._id}` }]
});
```

When documents are created, updated, or deleted, the graph updates automatically.

---

### 3. Resync (one-time build or rebuild)

`kgBulkSync()` can replay your existing bindings to populate or rebuild the graph.
It uses your `bindModel()` logic internally, so you don’t have to re-map nodes or edges manually.

```js
const { kgBulkSync } = require('mongodb-kg');

await kgBulkSync({
  models: [
    { model: MflixMovie },
    { model: MflixUser },
    { model: MflixComment }
  ],
  mode: 'save',   // 'save' or 'findOneAndUpdate'
  concurrency: 8, // number of parallel docs processed
  maxPerModel: 0  // 0 = process all
});
```

Notes:
* It simply replays your bindings for each document.
* You can limit processing with `maxPerModel`.

---

### 4. Query the Graph

Expose your data through a simple API route.

```js
app.get('/api/graph', async (_req, res) => {
  const [nodes, edges] = await Promise.all([
    NodesModel.find({}).lean(),
    EdgesModel.find({}).lean()
  ]);
  res.json({ nodes, edges });
});
```

You can visualize this data using D3.js, Cytoscape.js, or any other graph library.
A minimal D3 example is included in `/public/js/graph.js` of the mflix example. 

---

## API Reference

### kgInit(options)

Initializes the SDK.

| Option     | Type           | Description                                                          |
| ---------- | -------------- | -------------------------------------------------------------------- |
| nodesModel | Mongoose model | Required. Stores graph nodes.                                        |
| edgesModel | Mongoose model | Required. Stores graph edges.                                        |
| repos      | Object         | Optional. Additional repositories accessible in `edges()` functions. |

---

### bindModel(model, config)

Attaches middleware so your model automatically updates the graph.

| Key             | Type     | Required | Description                                                                |
| --------------- | -------- | -------- | -------------------------------------------------------------------------- |
| node(doc)       | Function | Yes      | Returns a node object; must include a unique string `id`.                  |
| edges(doc, ctx) | Function | No       | Returns an array of edges.                                                 |
| cleanup(doc)    | Function | No       | Returns filters for removing nodes and edges when the document is deleted. |

---

### createGraphModels(options)

Builds `NodeModel` and `EdgeModel` schemas with defaults and indexes.
Returns `{ NodeModel, EdgeModel }`.

| Option                | Type                | Description                                     |
| --------------------- | ------------------- | ----------------------------------------------- |
| node.name             | String              | Name of the node model (default: `GraphNode`).  |
| node.customFields     | Object              | Additional fields for node `properties`.        |
| node.typeEnum         | Array               | Allowed values for the `type` field (optional). |
| edge.name             | String              | Name of the edge model (default: `GraphEdge`).  |
| edge.customFields     | Object              | Additional fields for edge `properties`.        |
| edge.relationshipEnum | Array               | Allowed `relationship` values (optional).       |
| connection            | Mongoose connection | Optional; defaults to global connection.        |

---

### kgBulkSync(options)

Synchronizes or rebuilds your knowledge graph.

#### Resync mode (recommended)

Replays all your bindings across existing documents.

| Option      | Type   | Default  | Description                           |
| ----------- | ------ | -------- | ------------------------------------- |
| models      | Array  | []       | Array of `{ model, query?, label? }`. |
| mode        | String | `'save'` | Operation to trigger hooks.           |
| concurrency | Number | 8        | Parallelism for processing documents. |
| maxPerModel | Number | 0        | 0 = all documents.                    |

#### Classic upsert mode (deprecated)

Manually upserts nodes and edges.

| Option       | Type   | Description                        |
| ------------ | ------ | ---------------------------------- |
| desiredNodes | Array  | Array of node objects.             |
| desiredEdges | Array  | Array of edge objects.             |
| keepExtra    | Object | `{ edges: true }` to skip pruning. |

Use this only for legacy scripts.
Future versions focus on the resync flow.

---

### Typical Workflow

```js
const { NodeModel, EdgeModel } = createGraphModels({ /* config */ });

kgInit({ nodesModel: NodeModel, edgesModel: EdgeModel });

bindModel(MflixMovie, { node: ... });
bindModel(MflixUser, { node: ... });
bindModel(MflixComment, { node: ..., edges: ... });

await kgBulkSync({
  models: [
    { model: MflixMovie },
    { model: MflixUser },
    { model: MflixComment }
  ]
});
```

---

## License

Apache 2.0  

Created by [@alexanderawolf](https://x.com/alexanderawolf).  

If this SDK helps your project, consider supporting its continued development:  
[Support via Stripe](https://buy.stripe.com/28E28q0TT6bo3jm5qC1RC00)  

If you use this SDK in your project, a link back is appreciated.
Pull requests and forks are welcome.
