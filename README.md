> **Status:** Experimental – actively evolving.  
> Feedback, issues, and pull requests are welcome.


# Knowledge Graph SDK x MongoDB (by Artificial Brains)

A generic Knowledge Graph SDK for Mongoose. It lets you turn any MongoDB collection into a knowledge graph where documents become nodes and relationships become edges.
The SDK wires itself into your Mongoose models through middleware so the graph stays in sync as your data changes.

---

## Demo

A working demo using this SDK is available here:  
[sdk-kg-x-mongo-mFlix Demo](https://github.com/artificial-brains-inc/mongodb-kg-sdk-mFlix)

The demo shows how to integrate **@artificialbrain/kgraph-x-mongo** into a real Express + Mongoose app.

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
npm install @artificialbrain/kgraph-x-mongo
```

Mongoose is a peer dependency; bring your own compatible version.

---

## Quick Start

This example uses the **mflix** dataset.
We create nodes for `movies` and `users`, and edges linking commenters to the movies via 'comment_on' from the `comments` model.

### 1. Initialize the SDK

Tell the SDK which Mongoose models will store your nodes and edges.

```js
const mongoose = require('mongoose');
const { kgInit } = require('@artificialbrain/kgraph-x-mongo');

const NodesModel = require('./models/nodes');
const EdgesModel = require('./models/edges');

kgInit({
  nodesModel: NodesModel,
  edgesModel: EdgesModel
});
```

---

### 1a. Auto-create Graph Models (optional)

You can automatically generate `NodeModel` and `EdgeModel` using `createGraphModels()`. Be aware to index customFields as required to make it efficient (it will be indexed as properties.field). 

```js
const { createGraphModels, kgInit } = require('@artificialbrain/kgraph-x-mongo');

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

In your model definition (e.g. movies)
```js


const { bindModel } = require('@artificialbrain/kgraph-x-mongo');


const MovieSchema = new Schema({ /* your schema */});

// Movies → nodes
bindModel(MovieSchema, {
    node: (m) => ({
      id: `movie_${m._id}`,
      label: m.title || 'Untitled Movie',
      type: 'movie',
      source_collection: 'movies',
      source_id: m._id,
      properties: { title: m.title, plot: m.plot, year: m.year }
    }),
    cleanup: (m) => [{ source: `movie_${m._id}` }, { target: `movie_${m._id}` }]
  });

//make sure you bind your model before exporting it. 
module.exports = mongoose.model('MflixMovie', MovieSchema);

```

Example 2: Edges in your comments model

``` js 

const mongoose = require('mongoose');
const { Schema } = mongoose;
const { bindModel } = require('@artificialbrain/kgraph-x-mongo');


const CommentSchema = new Schema({
  /* schema */
});


// Commenter → edge comment → movie
  bindModel(CommentSchema, {
    edges: (c) => {
      const commenter = `user_${c.email}`;
      const movie     = `movie_${c.movie_id}`;
      return [{
        id: `${commenter}_commented_on_${movie}`,
        source: commenter,
        target: movie,
        relationship: 'commented_on',
        weight: 1, // adjust as necessary
        properties: { text: c.text ?? null }
      }];
    },
    cleanup: (c) => [{ source: `user_${c.email}` }]
  });

module.exports = mongoose.model('MflixComment', CommentSchema);

```

When documents are created, updated, or deleted, the graph updates automatically.
You can create nodes and edges in one single bind

bindModel(Schema, {
  node: (n) => {
    ...
  },
  edges: (e) => {
    ...
  }
})

---

### 3. Sync existing data (one-time build or rebuild)

`kgBulkSync()` can replay your existing bindings to populate or rebuild the graph.
It uses your `bindModel()` logic internally, so you don’t have to re-map nodes or edges manually.
Use only when building the graph for the first time in a database that already contains data. 

```js
const { kgBulkSync } = require('@artificialbrain/kgraph-x-mongo');

await kgBulkSync({
  models: [
    { model: MflixMovie },
    { model: MflixUser },
    { model: MflixComment },
  ],
  useBindings: true,    // must be true for initial build
  batchSize: 2000,     // how many upserts per bulkWrite batch
  maxPerModel: 0,      // 0 = all
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

If querying nodes and edges to diplay the graph, make sure you query one first, and then run a query based on edge's target or source to query the proper relationships between nodes. 

You can visualize data using D3.js, Cytoscape.js, or any other graph library.
A minimal D3 example is included in `/public/js/graph.js` of the mflix example. 

---

### 4A. Query Structural Distance (Unweighted)

You can calculate the shortest path between any two nodes in your graph using:

``` js 

kgShortestPath(startId, endId, options).

```
This method measures the number of hops between two entities (ignoring edge weights).
It’s useful for exploring degrees of connection — for example, how two users are related through the movies they’ve both commented on.

Example: Find how closely two users are connected through shared movies

```js


const { distance, path } = await MflixComment.kgShortestPath(
  'user_alice@example.com',
  'user_bob@example.com',
  { directed: false, maxDepth: 8 }
);

console.log(distance); // 3
console.log(path);     // [ 'user_alice@example.com', 'movie_Inception', 'user_bob@example.com' ]

```

Interpretation:

This means Alice and Bob are 3 steps apart in the comment network: Alice → Inception ← Bob.
If they had both commented on the same movie, the distance would be 1.
Longer distances indicate weaker or indirect relationships — for example, two users who share a connection through multiple other users and movies.

Use this to analyze:
* Communities of users clustered by shared interests.
* Movie popularity (how many users it connects).
* Degrees of separation between people or content.



### 4B. Query Weighted Distance (Semantic)

You can also calculate the lowest-cost path between two nodes using 

``` js

kgWeightedPath(startId, endId, options).

```

Weighted distance considers each edge’s numeric weight (e.g., comment sentiment, frequency, or affinity),
so it measures strength or similarity rather than just closeness.

Example: Compare two movies based on user overlap and comment sentiment

``` js 

const result = await MflixComment.kgWeightedPath(
  'movie_Inception',
  'movie_Interstellar',
  {
    directed: true,
    weightField: 'weight',
    defaultWeight: 1
  }
);

console.log(result);
// → { distance: 2.4, path: [ 'movie_Inception', 'user_42', 'movie_Interstellar' ] }

```

Interpretation:

In this example, Inception and Interstellar are 2.4 units apart, meaning they share overlapping audiences with moderately strong engagement.
A smaller number implies stronger similarity or tighter audience connection.

Use this to:
* Recommend similar movies based on shared users or sentiments.
* Identify influential users who bridge communities.
* Detect trend propagation — how opinions or interests travel across the graph.



### 4C. Generic Recommendations

Use `kgRecommend(startId, options)` to fetch top-k related nodes without writing traversal code.
By default, this runs a 2-hop expansion with a fan-out cap of 64 neighbors per node (sorted by descending weight).

```js
const items = await AnyBoundModel.kgRecommend('node_X', {
  mode: 'weighted',            // 'unweighted' | 'weighted' (default: 'unweighted')
  limit: 5,                    // number of top related nodes to return
  relationship: 'connected_to',// edge type(s) to traverse
  direction: 'any',            // 'out' | 'in' | 'any' (default: 'any')
  targetType: 'nodeType',      // optional node type filter
  includePath: true,           // return path nodes for explainability (optional)
  // Advanced options:
  // metaPath: [
  //   { relationship: 'rated', direction: 'out' },
  //   { relationship: 'belongs_to', direction: 'in' }
  // ],
});


```
Notes:
* In current version, if multiple neighbors share the same weight, the order is deterministic (index order).



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
| useBinding  | Boolean| false    | true required for initial build       |
| batchSize   | Number | 1000     | Number of documents to sync.          |
| maxPerModel | Number | 0        | Max docs to sync per model            |


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

## License

Apache 2.0  

Created by [@artificialbrains.ai](https://artificialbrains.ai).
Follow us on [@alexanderawolf](https://x.com/alexanderawolf)  

If this SDK helps your project, consider supporting its continued development:  
[Support via Stripe](https://buy.stripe.com/fZufZi0wL6fG2ef79g7Zu00)  

If you use this SDK in your project, a link back is appreciated.

Pull requests and forks are welcome.


---


## About Artificial Brains

Artificial Brains is a Research and Innovation Lab accelerating human adoption of neuromorphic technologies.

While our research and vision looks far ahead, we release along the way (open source or subscription-first) 
whenever our progress can strengthen today’s ecosystems and it's transition to neuromorphic-native tech.

Join the ecosystem to access training, early releases, research, and tools shaping neuromorphic technology:
[@artificialbrains.ai](https://artificialbrains.ai) 