import yaml from "js-yaml"
import Ajv from "ajv"
import SourceMap from "js-yaml-source-map"
import { QueryRunner } from "typeorm"
import { AuthType, DisableRestMethod } from "@common/enums"
import { MetloConfigResp, UpdateMetloConfigParams } from "@common/types"
import { BlockFieldsService } from "services/block-fields"
import {
  AUTH_CONFIG_LIST_KEY,
  BLOCK_FIELDS_ALL_REGEX,
  BLOCK_FIELDS_LIST_KEY,
} from "~/constants"
import { getPathRegex } from "utils"
import { AuthenticationConfig, BlockFields } from "models"
import { RedisClient } from "utils/redis"
import Error500InternalServer from "errors/error-500-internal-server"
import Error400BadRequest from "errors/error-400-bad-request"
import { AppDataSource } from "data-source"
import { MetloConfig } from "models/metlo-config"
import { MetloContext } from "types"
import {
  createQB,
  getQB,
  insertValueBuilder,
  insertValuesBuilder,
} from "services/database/utils"
import { METLO_CONFIG_SCHEMA } from "./constants"

export const getMetloConfig = async (
  ctx: MetloContext,
): Promise<MetloConfigResp> => {
  return await createQB(ctx).from(MetloConfig, "config").getRawOne()
}

export const validateMetloConfig = (configString: string) => {
  configString = configString.trim()
  let metloConfig: object = null
  const map = new SourceMap()
  try {
    metloConfig = yaml.load(configString, { listener: map.listen() }) as object
    metloConfig = metloConfig ?? {}
  } catch (err) {
    throw new Error400BadRequest("Config is not a valid yaml file")
  }
  const ajv = new Ajv()
  const validate = ajv.compile(METLO_CONFIG_SCHEMA)
  const valid = validate(metloConfig)
  if (!valid) {
    const errors = validate.errors
    if (errors) {
      const error = errors[0]
      let instancePath = error.instancePath
        .replace(/\//g, ".")
        .replace(/~1/g, "/")
        .slice(1)
      let errorMessage = `${error.instancePath} ${error.message}`
      switch (error.keyword) {
        case "additionalProperties":
          const additionalProperty = error.params.additionalProperty
          instancePath += `.${additionalProperty}`
          errorMessage = `property '${additionalProperty}' is not expected to be here`
          break
        case "enum":
          errorMessage = `must be equal to one of the allowed values: ${error.params.allowedValues?.join(
            ", ",
          )}`
          break
      }
      const lineNumber = map.lookup(instancePath)?.line
      throw new Error400BadRequest(
        `${errorMessage}${lineNumber ? ` on line ${lineNumber}` : ""}`,
      )
    }
  }
  return metloConfig
}

export const updateMetloConfig = async (
  ctx: MetloContext,
  updateMetloConfigParams: UpdateMetloConfigParams,
) => {
  await populateMetloConfig(ctx, updateMetloConfigParams.configString)
}

const addToBlockFields = (
  blockFieldsEntries: BlockFields[],
  host: string,
  method: DisableRestMethod,
  path: string,
  pathRegex: string,
  disabledPaths: string[],
) => {
  const disabledPathsObj = {
    reqQuery: [],
    reqHeaders: [],
    reqBody: [],
    resHeaders: [],
    resBody: [],
  }
  disabledPaths.forEach(path => {
    if (path.includes("req.query")) disabledPathsObj.reqQuery.push(path)
    else if (path.includes("req.headers"))
      disabledPathsObj.reqHeaders.push(path)
    else if (path.includes("req.body")) disabledPathsObj.reqBody.push(path)
    else if (path.includes("res.headers"))
      disabledPathsObj.resHeaders.push(path)
    else if (path.includes("res.body")) disabledPathsObj.resBody.push(path)
  })
  const blockFieldEntry = BlockFields.create()
  blockFieldEntry.host = host
  blockFieldEntry.method = method
  blockFieldEntry.path = path
  blockFieldEntry.pathRegex = pathRegex
  blockFieldEntry.disabledPaths = disabledPathsObj
  blockFieldEntry.numberParams = BlockFieldsService.getNumberParams(
    pathRegex,
    method,
    path,
  )
  blockFieldsEntries.push(blockFieldEntry)
}

const populateBlockFields = async (
  ctx: MetloContext,
  metloConfig: object,
  queryRunner: QueryRunner,
) => {
  const blockFieldsDoc = metloConfig?.["blockFields"]
  const blockFieldsEntries: BlockFields[] = []
  const currBlockFieldsEntries = await RedisClient.getValuesFromSet(
    ctx,
    BLOCK_FIELDS_LIST_KEY,
  )
  if (blockFieldsDoc) {
    for (const host in blockFieldsDoc) {
      const hostObj = blockFieldsDoc[host]
      let allDisablePaths = []
      if (hostObj) {
        if (hostObj["ALL"]) {
          allDisablePaths = hostObj["ALL"]["disable_paths"] ?? []
          const pathRegex = BLOCK_FIELDS_ALL_REGEX
          const path = "/"
          addToBlockFields(
            blockFieldsEntries,
            host,
            DisableRestMethod.ALL,
            path,
            pathRegex,
            allDisablePaths,
          )
        }
        for (const endpoint in hostObj) {
          if (endpoint && endpoint !== "ALL") {
            let endpointDisablePaths = allDisablePaths
            if (hostObj[endpoint]["ALL"]) {
              endpointDisablePaths = endpointDisablePaths?.concat(
                hostObj[endpoint]["ALL"]["disable_paths"] ?? [],
              )
              const pathRegex = getPathRegex(endpoint)
              addToBlockFields(
                blockFieldsEntries,
                host,
                DisableRestMethod.ALL,
                endpoint,
                pathRegex,
                endpointDisablePaths,
              )
            }
            for (const method in hostObj[endpoint]) {
              if (method && method !== "ALL") {
                const blockFieldMethod = DisableRestMethod[method]
                const pathRegex = getPathRegex(endpoint)
                const disabledPaths = endpointDisablePaths?.concat(
                  hostObj[endpoint][method]?.["disable_paths"] ?? [],
                )
                addToBlockFields(
                  blockFieldsEntries,
                  host,
                  blockFieldMethod,
                  endpoint,
                  pathRegex,
                  disabledPaths,
                )
              }
            }
          }
        }
      }
    }
  }
  await getQB(ctx, queryRunner).delete().from(BlockFields).execute()
  await insertValuesBuilder(
    ctx,
    queryRunner,
    BlockFields,
    blockFieldsEntries,
  ).execute()
  if (currBlockFieldsEntries) {
    await RedisClient.deleteFromRedis(ctx, [
      ...currBlockFieldsEntries,
      BLOCK_FIELDS_LIST_KEY,
    ])
  }
}

const populateAuthentication = async (
  ctx: MetloContext,
  metloConfig: object,
  queryRunner: QueryRunner,
) => {
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    console.error(`No ENCRYPTION_KEY found. Cannot set authentication config.`)
    throw new Error500InternalServer(
      "No ENCRYPTION_KEY found. Cannot set authentication config.",
    )
  }
  const authConfigDoc = metloConfig?.["authentication"]
  const authConfigEntries: AuthenticationConfig[] = []
  const currAuthConfigEntries = await RedisClient.getValuesFromSet(
    ctx,
    AUTH_CONFIG_LIST_KEY,
  )
  if (authConfigDoc) {
    authConfigDoc.forEach(item => {
      const newConfig = new AuthenticationConfig()
      newConfig.host = item.host
      newConfig.authType = item.authType as AuthType
      if (item.headerKey) newConfig.headerKey = item.headerKey
      if (item.jwtUserPath) newConfig.jwtUserPath = item.jwtUserPath
      if (item.cookieName) newConfig.cookieName = item.cookieName
      authConfigEntries.push(newConfig)
    })
  }
  const deleteQb = getQB(ctx, queryRunner).delete().from(AuthenticationConfig)
  const addQb = insertValuesBuilder(
    ctx,
    queryRunner,
    AuthenticationConfig,
    authConfigEntries,
  )
  await deleteQb.execute()
  await addQb.execute()
  if (currAuthConfigEntries) {
    await RedisClient.deleteFromRedis(ctx, [
      ...currAuthConfigEntries,
      AUTH_CONFIG_LIST_KEY,
    ])
  }
}

export const populateMetloConfig = async (
  ctx: MetloContext,
  configString: string,
) => {
  const queryRunner = AppDataSource.createQueryRunner()
  try {
    await queryRunner.connect()
    const metloConfig = validateMetloConfig(configString)
    await queryRunner.startTransaction()
    await populateAuthentication(ctx, metloConfig, queryRunner)
    await populateBlockFields(ctx, metloConfig, queryRunner)
    const metloConfigEntry = await getQB(ctx, queryRunner)
      .select(["uuid"])
      .from(MetloConfig, "config")
      .getRawOne()
    if (metloConfigEntry) {
      await getQB(ctx, queryRunner)
        .update(MetloConfig)
        .set({ configString })
        .execute()
    } else {
      const newConfig = MetloConfig.create()
      newConfig.configString = configString
      await insertValueBuilder(
        ctx,
        queryRunner,
        MetloConfig,
        newConfig,
      ).execute()
    }
    await queryRunner.commitTransaction()
  } catch (err) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction()
    }
    throw err
  } finally {
    await queryRunner.release()
  }
}
