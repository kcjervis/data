import Axios from "axios"
import fs from "fs"
import { sum, flatMap, range } from "lodash"
import rawmaps, { PiroEnemy, MapData } from "./rawmaps"
import Signale from "signale"
import Kcnav from "./kcnav"

const axios = Axios.create({ baseURL: "http://kc.piro.moe/api/routing", timeout: 60000 })

const sleep = (msec: number) => new Promise((resolve) => setTimeout(resolve, msec))

const createParams = (mapKey: string, edges: string[], diff?: number) => {
  const params = {
    minDiff: diff,
    maxDiff: diff,
    minGaugeLevel: 0,
    maxGaugeLevel: 9999,
    minGauge: 1,
    maxGauge: 4,
  }

  const getParams = (start: string) => ({
    ...params,
    map: mapKey,
    edges: edges.join(","),
    start,
  })

  return getParams("2020-06-25")
}

export type PiroEnemycomps = { entryCount?: number; entries: PiroEnemy[] }

const getNodeEnemies = async (map: string, edges: string[], diff?: number, count = 0): Promise<PiroEnemy[]> => {
  try {
    const params = createParams(map, edges, diff)
    const res = await axios.get<PiroEnemycomps>("/enemycomps", { params })

    return res.data.entries.map((enemy) => ({ ...enemy, diff }))
  } catch (error) {
    console.error(error.code)
    await sleep(10000)
    if (count > 4) return []
    return await getNodeEnemies(map, edges, diff, count++)
  }
}

const getEventNodeEnemies = async (map: string, edges: string[]) => {
  const res = await Promise.all([1, 2, 3, 4].map((diff) => getNodeEnemies(map, edges, diff)))
  return res.flat()
}

class MapObject {
  private cache?: MapData
  constructor(public id: number, public caching = true) {
    this.cache = rawmaps.find((map) => map.mapId === id)
  }

  get mapKey() {
    return `${this.worldId}-${this.areaId}`
  }

  get worldId() {
    return Math.floor(this.id / 10)
  }

  get areaId() {
    return this.id % 10
  }

  get isEvent() {
    return this.worldId > 10
  }

  public findNodeCash = (nodeId: string) => this.cache?.nodes.find((node) => node.nodeId === nodeId)

  private findCacheEnemies = (nodeId: string) => this.cache?.nodes.find((node) => node.nodeId === nodeId)?.enemies

  public getNodeEnemies = async (nodeId: string, edges: string[]) => {
    const { mapKey, isEvent } = this
    const signale = Signale.scope(`${mapKey} ${nodeId}`)

    signale.await()
    let enemies: PiroEnemy[] | void
    if (isEvent) {
      enemies = await getEventNodeEnemies(mapKey, edges).catch(() => signale.error("error"))
    } else {
      enemies = await getNodeEnemies(mapKey, edges).catch(() => signale.error("error"))
    }

    if (!enemies || enemies.length === 0) {
      const cacheEnemies = this.findCacheEnemies(nodeId)
      if (cacheEnemies) {
        signale.info("cache")
        return cacheEnemies
      }
      signale.error("no enemy")
      return
    }

    signale.success()
    return enemies
  }

  public getMapData = async (): Promise<MapData> => {
    const { id: mapId, mapKey, cache, caching } = this
    if (caching && cache) {
      return cache
    }

    const nodeRecord = await Kcnav.getNodeRecord(mapKey)
    const nodes = new Array<{ nodeId: string; enemies: PiroEnemy[] }>()

    for (const [nodeId, edges] of nodeRecord) {
      const enemies = await this.getNodeEnemies(nodeId, edges)
      if (enemies) {
        nodes.push({ nodeId, enemies })
      }
    }

    return { mapId, nodes }
  }
}

type WorldConfig = [number, number, boolean?]
export const download = async () => {
  const configs: WorldConfig[] = [
    [1, 6],
    [2, 5],
    [3, 5],
    [4, 5],
    [5, 5],
    [6, 5],
    [7, 2],
    [45, 3],
    [46, 6],
    [47, 1],
    [48, 4, false],
  ]
  const mapConfigs = configs.flatMap(([worldId, length, cache]) =>
    range(length).map((index) => [worldId * 10 + index + 1, cache] as const)
  )
  const mapList = mapConfigs.map((config) => new MapObject(...config))

  const results: MapData[] = []

  for (const map of mapList) {
    results.push(await map.getMapData())
  }

  const maps = flatMap(results)
  await fs.promises.writeFile("scripts/piro/rawmaps.json", JSON.stringify(maps))
  return maps
}
