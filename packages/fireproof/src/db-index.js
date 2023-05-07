// @ts-ignore
import { create, load } from 'prolly-trees/db-index'
// import { create, load } from '../../../../prolly-trees/src/db-index.js'

import { sha256 as hasher } from 'multiformats/hashes/sha2'
// @ts-ignore
import { nocache as cache } from 'prolly-trees/cache'
// @ts-ignore
import { bf, simpleCompare } from 'prolly-trees/utils'
import { makeGetBlock, visMerkleTree } from './prolly.js'
// eslint-disable-next-line no-unused-vars
import { Database, cidsToProof } from './database.js'

import * as codec from '@ipld/dag-cbor'
// import { create as createBlock } from 'multiformats/block'
import { TransactionBlockstore, doTransaction } from './blockstore.js'
// @ts-ignore
import charwise from 'charwise'

const ALWAYS_REBUILD = false // todo: remove

const compare = (a, b) => {
  const [aKey, aRef] = a
  const [bKey, bRef] = b
  const comp = simpleCompare(aKey, bKey)
  if (comp !== 0) return comp
  return refCompare(aRef, bRef)
}

const refCompare = (aRef, bRef) => {
  if (Number.isNaN(aRef)) return -1
  if (Number.isNaN(bRef)) throw new Error('ref may not be Infinity or NaN')
  if (aRef === Infinity) return 1 // need to test this on equal docids!
  // if (!Number.isFinite(bRef)) throw new Error('ref may not be Infinity or NaN')
  return simpleCompare(aRef, bRef)
}

const dbIndexOpts = { cache, chunker: bf(30), codec, hasher, compare }
const idIndexOpts = { cache, chunker: bf(30), codec, hasher, compare: simpleCompare }

const makeDoc = ({ key, value }) => ({ _id: key, ...value })

/**
 * JDoc for the result row type.
 * @typedef {Object} ChangeEvent
 * @property {string} key - The key of the document.
 * @property {Object} value - The new value of the document.
 * @property {boolean} [del] - Is the row deleted?
 * @memberof DbIndex
 */

/**
 * JDoc for the result row type.
 * @typedef {Object} DbIndexEntry
 * @property {string[]} key - The key for the DbIndex entry.
 * @property {Object} value - The value of the document.
 * @property {boolean} [del] - Is the row deleted?
 * @memberof DbIndex
 */

/**
 * Transforms a set of changes to DbIndex entries using a map function.
 *
 * @param {ChangeEvent[]} changes
 * @param {Function} mapFn
 * @returns {DbIndexEntry[]} The DbIndex entries generated by the map function.
 * @private
 * @memberof DbIndex
 */
const indexEntriesForChanges = (changes, mapFn) => {
  const indexEntries = []
  changes.forEach(({ key, value, del }) => {
    // key is _id, value is the document
    if (del || !value) return
    let mapCalled = false
    const mapReturn = mapFn(makeDoc({ key, value }), (k, v) => {
      mapCalled = true
      if (typeof k === 'undefined') return
      indexEntries.push({
        key: [charwise.encode(k), key],
        value: v || null
      })
    })
    if (!mapCalled && mapReturn) {
      indexEntries.push({
        key: [charwise.encode(mapReturn), key],
        value: null
      })
    }
  })
  return indexEntries
}

/**
 * Represents an DbIndex for a Fireproof database.
 *
 * @class DbIndex
 * @classdesc An DbIndex can be used to order and filter the documents in a Fireproof database.
 *
 * @param {Database} database - The Fireproof database instance to DbIndex.
 * @param {Function} mapFn - The map function to apply to each entry in the database.
 *
 */
export class DbIndex {
  /**
   * @param {Database} database
   */
  constructor (database, name, mapFn, clock = null, opts = {}) {
    this.database = database
    if (!database.indexBlocks) {
      database.indexBlocks = new TransactionBlockstore(
        database?.name + '.indexes',
        database.blocks.valet?.getKeyMaterial()
      )
    }
    if (typeof name === 'function') {
      // app is using deprecated API, remove in 0.7
      opts = clock || {}
      clock = mapFn || null
      mapFn = name
      name = null
    }
    this.applyMapFn(mapFn, name)

    this.indexById = { root: null, cid: null }
    this.indexByKey = { root: null, cid: null }
    this.dbHead = null
    if (clock) {
      this.indexById.cid = clock.byId
      this.indexByKey.cid = clock.byKey
      this.dbHead = clock.db
    }
    this.instanceId = this.database.instanceId + `.DbIndex.${Math.random().toString(36).substring(2, 7)}`
    this.updateIndexPromise = null
    if (!opts.temporary) {
      DbIndex.registerWithDatabase(this, this.database)
    }
  }

  applyMapFn (mapFn, name) {
    if (typeof mapFn === 'string') {
      this.mapFnString = mapFn
    } else {
      this.mapFn = mapFn
      this.mapFnString = mapFn.toString()
    }
    this.name = name || this.makeName()
  }

  makeName () {
    const regex = /\(([^,()]+,\s*[^,()]+|\[[^\]]+\],\s*[^,()]+)\)/g
    let matches = Array.from(this.mapFnString.matchAll(regex), match => match[1].trim())
    if (matches.length === 0) {
      matches = /=>\s*(.*)/.exec(this.mapFnString)
    }
    if (matches === null) {
      return this.mapFnString
    } else {
      // it's a consise arrow function, match everythign after the arrow
      this.includeDocsDefault = true
      return matches[1]
    }
  }

  static registerWithDatabase (inIndex, database) {
    if (!database.indexes.has(inIndex.mapFnString)) {
      database.indexes.set(inIndex.mapFnString, inIndex)
    } else {
      // merge our inIndex code with the inIndex clock or vice versa
      const existingIndex = database.indexes.get(inIndex.mapFnString)
      // keep the code instance, discard the clock instance
      if (existingIndex.mapFn) {
        // this one also has other config
        existingIndex.dbHead = inIndex.dbHead
        existingIndex.indexById.cid = inIndex.indexById.cid
        existingIndex.indexByKey.cid = inIndex.indexByKey.cid
      } else {
        inIndex.dbHead = existingIndex.dbHead
        inIndex.indexById.cid = existingIndex.indexById.cid
        inIndex.indexByKey.cid = existingIndex.indexByKey.cid
        database.indexes.set(inIndex.mapFnString, inIndex)
      }
    }
  }

  toJSON () {
    const indexJson = { name: this.name, code: this.mapFnString, clock: { db: null, byId: null, byKey: null } }
    indexJson.clock.db = this.dbHead?.map(cid => cid.toString())
    indexJson.clock.byId = this.indexById.cid?.toString()
    indexJson.clock.byKey = this.indexByKey.cid?.toString()
    return indexJson
  }

  static fromJSON (database, { code, clock, name }) {
    // console.log('DbIndex.fromJSON', database.constructor.name, code, clock)
    return new DbIndex(database, name, code, clock)
  }

  async visKeyTree () {
    return await visMerkleTree(this.database.indexBlocks, this.indexById.cid)
  }

  async visIdTree () {
    return await visMerkleTree(this.database.indexBlocks, this.indexByKey.cid)
  }

  /**
   * JSDoc for Query type.
   * @typedef {Object} DbQuery
   * @property {string[]} [range] - The range to query.
   * @memberof DbIndex
   */

  /**
   * Query object can have {range}
   * @param {DbQuery} query - the query range to use
   * @returns {Promise<{proof: {}, rows: Array<{id: string, key: string, value: any, doc?: any}>}>}
   * @memberof DbIndex
   * @instance
   */
  async query (query = {}, update = true) {
    // const callId = Math.random().toString(36).substring(2, 7)
    // todo pass a root to query a snapshot
    // console.time(callId + '.updateIndex')
    update && (await this.updateIndex(this.database.indexBlocks))
    // console.timeEnd(callId + '.updateIndex')
    // console.time(callId + '.doIndexQuery')
    // console.log('query', query)
    const response = await this.doIndexQuery(query)
    // console.timeEnd(callId + '.doIndexQuery')
    return {
      proof: { index: await cidsToProof(response.cids) },
      rows: response.result.map(({ id, key, row, doc }) => {
        return { id, key: charwise.decode(key), value: row, doc }
      })
    }
  }

  /**
   *
   * @param {any} resp
   * @param {any} query
   * @returns
   */
  async applyQuery (resp, query) {
    if (query.descending) {
      resp.result = resp.result.reverse()
    }
    if (query.limit) {
      resp.result = resp.result.slice(0, query.limit)
    }
    if (query.includeDocs) {
      resp.result = await Promise.all(
        resp.result.map(async row => {
          const doc = await this.database.get(row.id)
          return { ...row, doc }
        })
      )
    }
    return resp
  }

  async doIndexQuery (query = {}) {
    await loadIndex(this.database.indexBlocks, this.indexByKey, dbIndexOpts)
    if (!this.indexByKey.root) return { result: [] }
    if (query.includeDocs === undefined) query.includeDocs = this.includeDocsDefault
    if (query.range) {
      const encodedRange = query.range.map(key => charwise.encode(key))
      return await this.applyQuery(await this.indexByKey.root.range(...encodedRange), query)
    } else if (query.key) {
      const encodedKey = charwise.encode(query.key)
      return await this.applyQuery(this.indexByKey.root.get(encodedKey), query)
    } else {
      const { result, ...all } = await this.indexByKey.root.getAllEntries()
      return await this.applyQuery(
        { result: result.map(({ key: [k, id], value }) => ({ key: k, id, row: value })), ...all },
        query
      )
    }
  }

  /**
   * Update the DbIndex with the latest changes
   * @private
   * @returns {Promise<void>}
   */

  async updateIndex (blocks) {
    // todo this could enqueue the request and give fresh ones to all second comers -- right now it gives out stale promises while working
    // what would it do in a world where all indexes provide a database snapshot to query?
    if (this.updateIndexPromise) {
      return this.updateIndexPromise.then(() => {
        this.updateIndexPromise = null
        return this.updateIndex(blocks)
      })
    }
    this.updateIndexPromise = this.innerUpdateIndex(blocks)
    this.updateIndexPromise.finally(() => {
      this.updateIndexPromise = null
    })
    return this.updateIndexPromise
  }

  async innerUpdateIndex (inBlocks) {
    const callTag = Math.random().toString(36).substring(4)
    // console.log(`updateIndex ${callTag} >`, this.instanceId, this.dbHead?.toString(), this.indexByKey.cid?.toString(), this.indexById.cid?.toString())
    // todo remove this hack
    if (ALWAYS_REBUILD) {
      this.indexById = { root: null, cid: null }
      this.indexByKey = { root: null, cid: null }
      this.dbHead = null
    }
    // console.log('dbHead', this.dbHead)
    // console.time(callTag + '.changesSince')
    const result = await this.database.changesSince(this.dbHead) // {key, value, del}
    // console.timeEnd(callTag + '.changesSince')
    // console.log('result.rows.length', result.rows.length)

    // console.time(callTag + '.doTransactionupdateIndex')
    // console.log('updateIndex changes length', result.rows.length)

    if (result.rows.length === 0) {
      // console.log('updateIndex < no changes', result.clock)
      this.dbHead = result.clock
      return
    }
    const didT = await doTransaction('updateIndex', inBlocks, async blocks => {
      let oldIndexEntries = []
      let removeByIdIndexEntries = []
      await loadIndex(blocks, this.indexById, idIndexOpts)
      await loadIndex(blocks, this.indexByKey, dbIndexOpts)
      // console.log('head', this.dbHead, this.indexById)
      if (this.indexById.root) {
        const oldChangeEntries = await this.indexById.root.getMany(result.rows.map(({ key }) => key))
        oldIndexEntries = oldChangeEntries.result.map(key => ({ key, del: true }))
        removeByIdIndexEntries = oldIndexEntries.map(({ key }) => ({ key: key[1], del: true }))
      }
      if (!this.mapFn) {
        throw new Error(
          'No live map function installed for index, cannot update. Make sure your index definition runs before any queries.' +
            (this.mapFnString ? ' Your code should match the stored map function source:\n' + this.mapFnString : '')
        )
      }
      const indexEntries = indexEntriesForChanges(result.rows, this.mapFn)
      const byIdIndexEntries = indexEntries.map(({ key }) => ({ key: key[1], value: key }))
      this.indexById = await bulkIndex(
        blocks,
        this.indexById,
        removeByIdIndexEntries.concat(byIdIndexEntries),
        idIndexOpts
      )
      this.indexByKey = await bulkIndex(blocks, this.indexByKey, oldIndexEntries.concat(indexEntries), dbIndexOpts)
      this.dbHead = result.clock
    }, false /* don't sync transaction -- maybe move this flag to database.indexBlocks? */)
    // todo index subscriptions
    // this.database.notifyExternal('dbIndex')
    // console.timeEnd(callTag + '.doTransactionupdateIndex')
    // console.log(`updateIndex ${callTag} <`, this.instanceId, this.dbHead?.toString(), this.indexByKey.cid?.toString(), this.indexById.cid?.toString())
    return didT
  }
}

/**
 * Update the DbIndex with the given entries
 * @param {import('./blockstore.js').Blockstore} blocks
 * @param {{root, cid}} inIndex
 * @param {DbIndexEntry[]} indexEntries
 * @private
 */
async function bulkIndex (blocks, inIndex, indexEntries, opts) {
  if (!indexEntries.length) return inIndex
  const putBlock = blocks.put.bind(blocks)
  const { getBlock } = makeGetBlock(blocks)
  let returnRootBlock
  let returnNode
  if (!inIndex.root) {
    const cid = inIndex.cid
    if (!cid) {
      for await (const node of await create({ get: getBlock, list: indexEntries, ...opts })) {
        const block = await node.block
        await putBlock(block.cid, block.bytes)
        returnRootBlock = block
        returnNode = node
      }
      return { root: returnNode, cid: returnRootBlock.cid }
    }
    inIndex.root = await load({ cid, get: getBlock, ...dbIndexOpts })
  }
  const { root, blocks: newBlocks } = await inIndex.root.bulk(indexEntries)
  if (root) {
    returnRootBlock = await root.block
    returnNode = root
    for await (const block of newBlocks) {
      await putBlock(block.cid, block.bytes)
    }
    await putBlock(returnRootBlock.cid, returnRootBlock.bytes)
    return { root: returnNode, cid: returnRootBlock.cid }
  } else {
    // throw new Error('test for index after delete')
    return { root: null, cid: null }
  }
}

async function loadIndex (blocks, index, indexOpts) {
  if (!index.root) {
    const cid = index.cid
    if (!cid) {
      // console.log('no cid', index)
      // throw new Error('cannot load index')
      return null
    }
    const { getBlock } = makeGetBlock(blocks)
    index.root = await load({ cid, get: getBlock, ...indexOpts })
  }
  return index.root
}
