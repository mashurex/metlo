import { FindManyOptions, IsNull, LessThanOrEqual, Raw } from "typeorm"
import { v4 as uuidv4 } from "uuid"
import { DateTime } from "luxon"
import {
  getDataType,
  isParameter,
  isSuspectedParamater,
  parsedJson,
  parsedJsonNonNull,
  skipAutoGeneratedMatch,
} from "utils"
import { ApiEndpoint, ApiTrace, OpenApiSpec, Alert, DataField } from "models"
import { AppDataSource } from "data-source"
import { AlertType, DataType, RestMethod, SpecExtension } from "@common/enums"
import { getPathTokens } from "@common/utils"
import { AlertService } from "services/alert"
import { DataFieldService } from "services/data-field"
import { DatabaseService } from "services/database"
import axios from "axios"
import { SpecService } from "services/spec"
import {
  aggregateTracesDataHourlyQuery,
  aggregateTracesDataMinutelyQuery,
} from "./queries"

interface GenerateEndpoint {
  parameterizedPath: string
  host: string
  regex: string
  method: RestMethod
  traces: ApiTrace[]
}

enum In {
  QUERY = "query",
  HEADER = "header",
  PATH = "path",
  COOKIE = "cookie",
}

interface BodySchema {
  type?: DataType
  items?: BodySchema
  properties?: Record<string, BodySchema>
}

interface BodyContent {
  [key: string]: { schema?: BodySchema }
}

interface Responses {
  [key: string]: {
    description: string
    headers?: BodyContent
    content?: BodyContent
  }
}

export class JobsService {
  static parseSchema(bodySchema: BodySchema, parsedBody: any) {
    const dataType = getDataType(parsedBody)
    if (dataType === DataType.OBJECT) {
      if (Object.keys(parsedBody).length === 0) {
        bodySchema = {
          type: DataType.OBJECT,
          properties: {
            ...bodySchema?.properties,
          },
        }
      }
      for (let property in parsedBody) {
        bodySchema = {
          type: DataType.OBJECT,
          properties: {
            ...bodySchema?.properties,
            [property]: this.parseSchema(
              bodySchema?.properties?.[property],
              parsedBody[property],
            ),
          },
        }
      }
      return bodySchema
    } else if (dataType === DataType.ARRAY) {
      const l = parsedBody.length
      if (l === 0) {
        bodySchema = {
          type: DataType.ARRAY,
          items: {
            ...bodySchema?.items,
          },
        }
      }
      for (let i = 0; i < l; i++) {
        bodySchema = {
          type: DataType.ARRAY,
          items: this.parseSchema(bodySchema?.items, parsedBody[i] ?? ""),
        }
      }
      return bodySchema
    } else if (dataType === DataType.UNKNOWN) {
      return {
        type: dataType,
        nullable: true,
      }
    } else {
      return {
        type: dataType,
      }
    }
  }

  static parseContent(bodySpec: BodyContent, bodyString: string, key: string) {
    let parsedBody = parsedJson(bodyString)
    let nonNullKey: string
    if (!parsedBody && bodyString) {
      nonNullKey = key || "*/*"
      parsedBody = bodyString
    } else if (parsedBody) {
      nonNullKey = key || "*/*"
    } else {
      return
    }
    if (!bodySpec?.[nonNullKey]) {
      bodySpec[nonNullKey] = { schema: {} }
    }
    bodySpec[nonNullKey] = {
      schema: this.parseSchema(bodySpec[nonNullKey].schema, parsedBody),
    }
  }

  static async analyzeTraces(): Promise<void> {
    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      const qb = queryRunner.manager
        .createQueryBuilder()
        .from(ApiTrace, "traces")
        .where(`"apiEndpointUuid" IS NOT NULL`)
        .andWhere("analyzed = FALSE")
        .orderBy('"createdAt"', "ASC")
        .limit(5000)
      let traces = await qb.getRawMany()

      while (traces && traces.length > 0) {
        for (const trace of traces) {
          const apiEndpoint = await queryRunner.manager.findOne(ApiEndpoint, {
            where: {
              uuid: trace.apiEndpointUuid,
            },
            relations: { dataFields: true },
          })
          if (apiEndpoint) {
            apiEndpoint.updateDates(trace.createdAt)
            const dataFields = DataFieldService.findAllDataFields(
              trace,
              apiEndpoint,
            )
            let alerts = await SpecService.findOpenApiSpecDiff(
              trace,
              apiEndpoint,
            )
            const sensitiveDataAlerts =
              await AlertService.createDataFieldAlerts(
                dataFields,
                apiEndpoint.uuid,
                apiEndpoint.path,
                trace,
              )
            alerts = alerts?.concat(sensitiveDataAlerts)

            await queryRunner.startTransaction()
            await DatabaseService.retryTypeormTransaction(
              () =>
                queryRunner.manager
                  .createQueryBuilder()
                  .update(ApiTrace)
                  .set({ analyzed: true })
                  .where("uuid = :id", { id: trace.uuid })
                  .execute(),
              5,
            )
            await DatabaseService.retryTypeormTransaction(
              () =>
                queryRunner.manager
                  .createQueryBuilder()
                  .insert()
                  .into(DataField)
                  .values(dataFields)
                  .orUpdate(
                    [
                      "dataClasses",
                      "scannerIdentified",
                      "dataType",
                      "dataTag",
                      "matches",
                    ],
                    ["dataSection", "dataPath", "apiEndpointUuid"],
                  )
                  .execute(),
              5,
            )
            await DatabaseService.retryTypeormTransaction(
              () =>
                queryRunner.manager
                  .createQueryBuilder()
                  .insert()
                  .into(Alert)
                  .values(alerts)
                  .orIgnore()
                  .execute(),
              5,
            )
            await DatabaseService.retryTypeormTransaction(
              () =>
                queryRunner.manager
                  .createQueryBuilder()
                  .update(ApiEndpoint)
                  .set({
                    firstDetected: apiEndpoint.firstDetected,
                    lastActive: apiEndpoint.lastActive,
                    riskScore: apiEndpoint.riskScore,
                  })
                  .where("uuid = :id", { id: apiEndpoint.uuid })
                  .execute(),
              5,
            )
            await queryRunner.commitTransaction()
          }
        }
        traces = await qb.getRawMany()
      }
    } catch (err) {
      console.error(`Encountered error while analyzing traces: ${err}`)
      await queryRunner.rollbackTransaction()
    } finally {
      await queryRunner.release()
    }
  }

  static async clearApiTraces(): Promise<void> {
    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      const now = DateTime.now().startOf("hour")
      const oneHourAgo = now.minus({ hours: 1 }).toJSDate()

      const maxTimeRes = await queryRunner.manager
        .createQueryBuilder()
        .select([`MAX("createdAt") as "maxTime"`])
        .from(ApiTrace, "traces")
        .where('"apiEndpointUuid" IS NOT NULL')
        .andWhere("analyzed = TRUE")
        .andWhere('"createdAt" < :oneHourAgo', { oneHourAgo })
        .getRawOne()
      const maxTime: Date = maxTimeRes?.maxTime ?? null

      if (maxTime) {
        await queryRunner.startTransaction()
        await queryRunner.query(aggregateTracesDataMinutelyQuery, [maxTime])
        await queryRunner.query(aggregateTracesDataHourlyQuery, [maxTime])
        await queryRunner.manager
          .createQueryBuilder()
          .delete()
          .from(ApiTrace)
          .where('"apiEndpointUuid" IS NOT NULL')
          .andWhere("analyzed = TRUE")
          .andWhere('"createdAt" <= :maxTime', { maxTime })
          .execute()
        await queryRunner.commitTransaction()
      }
    } catch (err) {
      console.error(`Encountered error while clearing trace data: ${err}`)
      await queryRunner.rollbackTransaction()
    } finally {
      await queryRunner?.release()
    }
  }

  static async generateEndpointsFromTraces(): Promise<void> {
    const queryRunner = AppDataSource.createQueryRunner()
    await queryRunner.connect()
    try {
      const currTime = new Date()
      const tracesFindOptions: FindManyOptions<ApiTrace> = {
        select: {
          uuid: true,
          path: true,
          method: true,
          host: true,
          createdAt: true,
        },
        where: {
          apiEndpointUuid: IsNull(),
          createdAt: LessThanOrEqual(currTime),
        },
        order: {
          createdAt: "ASC",
        },
        take: 1000,
      }
      let traces = await queryRunner.manager.find(ApiTrace, tracesFindOptions)
      while (traces && traces?.length > 0) {
        const regexToTracesMap: Record<string, GenerateEndpoint> = {}
        for (let i = 0; i < traces.length; i++) {
          const trace = traces[i]
          const apiEndpoint = await queryRunner.manager.findOne(ApiEndpoint, {
            where: {
              pathRegex: Raw(alias => `:path ~ ${alias}`, {
                path: trace.path,
              }),
              method: trace.method,
              host: trace.host,
            },
            relations: { openapiSpec: true },
            order: {
              numberParams: "ASC",
            },
          })
          if (apiEndpoint && !skipAutoGeneratedMatch(apiEndpoint, trace.path)) {
            apiEndpoint.updateDates(trace.createdAt)

            await queryRunner.startTransaction()
            await DatabaseService.retryTypeormTransaction(
              () =>
                queryRunner.manager
                  .createQueryBuilder()
                  .update(ApiTrace)
                  .set({ apiEndpointUuid: apiEndpoint.uuid })
                  .where("uuid = :id", { id: trace.uuid })
                  .execute(),
              5,
            )
            await DatabaseService.retryTypeormTransaction(
              () =>
                queryRunner.manager
                  .createQueryBuilder()
                  .update(ApiEndpoint)
                  .set({
                    firstDetected: apiEndpoint.firstDetected,
                    lastActive: apiEndpoint.lastActive,
                  })
                  .where("uuid = :id", { id: apiEndpoint.uuid })
                  .execute(),
              5,
            )
            await queryRunner.commitTransaction()
          } else {
            let found = false
            const regexes = Object.keys(regexToTracesMap)
            for (let x = 0; x < regexes.length && !found; x++) {
              const regex = regexes[x]
              if (
                RegExp(regex).test(
                  `${trace.host}-${trace.method}-${trace.path}`,
                )
              ) {
                found = true
                regexToTracesMap[regex].traces.push(trace)
              }
            }
            if (!found) {
              const pathTokens = getPathTokens(trace.path)
              let paramNum = 1
              let parameterizedPath = ""
              let pathRegex = String.raw``
              for (let j = 0; j < pathTokens.length; j++) {
                const tokenString = pathTokens[j]
                if (tokenString === "/") {
                  parameterizedPath += "/"
                  pathRegex += "/"
                } else if (tokenString.length > 0) {
                  if (isSuspectedParamater(tokenString)) {
                    parameterizedPath += `/{param${paramNum}}`
                    pathRegex += String.raw`/[^/]+`
                    paramNum += 1
                  } else {
                    parameterizedPath += `/${tokenString}`
                    pathRegex += String.raw`/${tokenString}`
                  }
                }
              }
              if (pathRegex.length > 0) {
                pathRegex = String.raw`^${pathRegex}$`
                const regexKey = `${trace.host}-${trace.method}-${pathRegex}`
                if (regexToTracesMap[regexKey]) {
                  regexToTracesMap[regexKey].traces.push(trace)
                } else {
                  regexToTracesMap[regexKey] = {
                    parameterizedPath,
                    host: trace.host,
                    regex: pathRegex,
                    method: trace.method,
                    traces: [trace],
                  }
                }
              }
            }
          }
        }

        for (const regex in regexToTracesMap) {
          const value = regexToTracesMap[regex]
          const apiEndpoint = new ApiEndpoint()
          apiEndpoint.uuid = uuidv4()
          apiEndpoint.path = value.parameterizedPath
          apiEndpoint.pathRegex = value.regex
          apiEndpoint.host = value.traces[0].host
          apiEndpoint.method = value.traces[0].method
          apiEndpoint.addNumberParams()

          const traceIds = []
          for (let i = 0; i < value.traces.length; i++) {
            const trace = value.traces[i]
            apiEndpoint.updateDates(trace.createdAt)
            traceIds.push(trace.uuid)
          }
          const alert = await AlertService.createAlert(
            AlertType.NEW_ENDPOINT,
            apiEndpoint,
          )

          await queryRunner.startTransaction()
          await DatabaseService.retryTypeormTransaction(
            () =>
              queryRunner.manager
                .createQueryBuilder()
                .insert()
                .into(ApiEndpoint)
                .values(apiEndpoint)
                .execute(),
            5,
          )
          await DatabaseService.retryTypeormTransaction(
            () =>
              queryRunner.manager
                .createQueryBuilder()
                .insert()
                .into(Alert)
                .values(alert)
                .execute(),
            5,
          )
          await DatabaseService.retryTypeormTransaction(
            () =>
              queryRunner.manager
                .createQueryBuilder()
                .update(ApiTrace)
                .set({ apiEndpointUuid: apiEndpoint.uuid })
                .where("uuid IN(:...ids)", { ids: traceIds })
                .execute(),
            5,
          )
          await queryRunner.commitTransaction()
        }
        traces = await queryRunner.manager.find(ApiTrace, tracesFindOptions)
      }
      console.log("Finished Generating Endpoints.")
      await this.generateOpenApiSpec()
    } catch (err) {
      console.error(`Encountered error while generating endpoints: ${err}`)
      queryRunner.rollbackTransaction()
    } finally {
      await queryRunner?.release()
    }
  }

  static async generateOpenApiSpec(): Promise<void> {
    console.log("Generating OpenAPI Spec Files...")
    try {
      const apiEndpointRepository = AppDataSource.getRepository(ApiEndpoint)
      const openApiSpecRepository = AppDataSource.getRepository(OpenApiSpec)
      const apiTraceRepository = AppDataSource.getRepository(ApiTrace)
      const nonSpecEndpoints = await apiEndpointRepository.findBy({
        openapiSpecName: IsNull(),
      })
      const currTime = new Date()
      const hostMap: Record<string, ApiEndpoint[]> = {}
      const specIntro = {
        openapi: "3.0.0",
        info: {
          title: "OpenAPI 3.0 Spec",
          version: "1.0.0",
          description: "An auto-generated OpenAPI 3.0 specification.",
        },
      }
      for (let i = 0; i < nonSpecEndpoints.length; i++) {
        const endpoint = nonSpecEndpoints[i]
        if (hostMap[endpoint.host]) {
          hostMap[endpoint.host].push(endpoint)
        } else {
          hostMap[endpoint.host] = [endpoint]
        }
      }
      for (const host in hostMap) {
        let spec = await openApiSpecRepository.findOneBy({
          name: `${host}-generated`,
        })
        let openApiSpec = {}
        if (spec) {
          openApiSpec = JSON.parse(spec.spec)
        } else {
          spec = new OpenApiSpec()
          spec.name = `${host}-generated`
          spec.isAutoGenerated = true
          spec.hosts = [host]
          openApiSpec = {
            ...specIntro,
            servers: [
              {
                url: host,
              },
            ],
            paths: {},
          }
        }
        const endpoints = hostMap[host]
        for (let i = 0; i < endpoints.length; i++) {
          const endpoint = endpoints[i]
          const paths = openApiSpec["paths"]
          const path = endpoint.path
          const method = endpoint.method.toLowerCase()
          const tracesQb = apiTraceRepository
            .createQueryBuilder()
            .where('"apiEndpointUuid" = :id', { id: endpoint.uuid })
          if (spec.updatedAt) {
            tracesQb.andWhere('"createdAt" > :updated', {
              updated: spec.updatedAt,
            })
            tracesQb.andWhere('"createdAt" <= :curr', { curr: currTime })
          } else {
            tracesQb.andWhere('"createdAt" <= :curr', { curr: currTime })
          }
          const traces = await tracesQb.orderBy('"createdAt"', "ASC").getMany()

          let parameters: Record<string, BodySchema> = {}
          let requestBodySpec: BodyContent = {}
          let responses: Responses = {}
          if (paths[path]) {
            if (paths[path][method]) {
              const specParameters = paths[path][method]["parameters"] ?? []
              requestBodySpec =
                paths[path][method]["requestBody"]?.["content"] ?? {}
              responses = paths[path][method]["responses"] ?? {}
              for (const parameter of specParameters) {
                parameters[`${parameter?.name}<>${parameter?.in}`] =
                  parameter?.schema ?? {}
              }
            } else {
              paths[path][method] = {}
            }
          } else {
            paths[path] = {
              [method]: {},
            }
          }

          for (const trace of traces) {
            const requestParamters = trace.requestParameters
            const requestHeaders = trace.requestHeaders
            const requestBody = trace.requestBody
            const responseHeaders = trace.responseHeaders
            const responseBody = trace.responseBody
            const responseStatusString =
              trace.responseStatus?.toString() || "default"
            let requestContentType = null
            let responseContentType = null
            const endpointTokens = getPathTokens(endpoint.path)
            const traceTokens = getPathTokens(trace.path)
            for (let i = 0; i < endpointTokens.length; i++) {
              const currToken = endpointTokens[i]
              if (isParameter(currToken)) {
                const key = `${currToken.slice(1, -1)}<>path`
                parameters[key] = this.parseSchema(
                  parameters[key] ?? {},
                  parsedJsonNonNull(traceTokens[i], true),
                )
              }
            }
            for (const requestParameter of requestParamters) {
              const key = `${requestParameter.name}<>query`
              parameters[key] = this.parseSchema(
                parameters[key] ?? {},
                parsedJsonNonNull(requestParameter.value, true),
              )
            }
            for (const requestHeader of requestHeaders) {
              const key = `${requestHeader.name}<>header`
              parameters[key] = this.parseSchema(
                parameters[key] ?? {},
                parsedJsonNonNull(requestHeader.value, true),
              )
              if (requestHeader.name.toLowerCase() === "content-type") {
                requestContentType = requestHeader.value.toLowerCase()
              }
            }
            for (const responseHeader of responseHeaders) {
              if (responseHeader.name.toLowerCase() === "content-type") {
                responseContentType = responseHeader.value.toLowerCase()
              }
              if (!responses[responseStatusString]?.headers) {
                responses[responseStatusString] = {
                  description: `${responseStatusString} description`,
                  ...responses[responseStatusString],
                  headers: {},
                }
              }
              this.parseContent(
                responses[responseStatusString]?.headers,
                responseHeader.value,
                responseHeader.name,
              )
            }

            // Request body only for put, post, options, patch, trace
            this.parseContent(requestBodySpec, requestBody, requestContentType)
            if (responseBody) {
              if (!responses[responseStatusString]?.content) {
                responses[responseStatusString] = {
                  description: `${responseStatusString} description`,
                  ...responses[responseStatusString],
                  content: {},
                }
              }
              this.parseContent(
                responses[responseStatusString]?.content,
                responseBody,
                responseContentType,
              )
            }
          }
          let specParameterList = []
          for (const parameter in parameters) {
            const splitParameter = parameter.split("<>")
            specParameterList.push({
              name: splitParameter[0],
              in: splitParameter[1],
              schema: parameters[parameter],
            })
          }
          if (specParameterList.length > 0) {
            paths[path][method]["parameters"] = specParameterList
          }
          if (Object.keys(requestBodySpec).length > 0) {
            paths[path][method]["requestBody"] = {
              content: {
                ...requestBodySpec,
              },
            }
          }
          if (Object.keys(responses).length > 0) {
            paths[path][method]["responses"] = {
              ...responses,
            }
          }

          // Add endpoint path parameters to parameter list
          endpoint.openapiSpec = spec
        }
        spec.spec = JSON.stringify(openApiSpec, null, 2)
        spec.updatedAt = currTime
        spec.extension = SpecExtension.JSON
        await DatabaseService.executeTransactions([[spec], endpoints], [], true)
      }
    } catch (err) {
      console.error(`Encountered error while generating OpenAPI specs: ${err}`)
    }
  }

  static async monitorEndpointForHSTS(): Promise<void> {
    try {
      const apiEndpointRepository = AppDataSource.getRepository(ApiEndpoint)
      const apiTraceRepository = AppDataSource.getRepository(ApiTrace)
      const alertsRepository = AppDataSource.getRepository(Alert)

      const alertableData: Array<[ApiEndpoint, ApiTrace, string]> = []

      for (const endpoint of await apiEndpointRepository
        .createQueryBuilder()
        .getMany()) {
        const latest_trace_for_endpoint = await apiTraceRepository.findOne({
          where: { apiEndpointUuid: endpoint.uuid },
          order: { createdAt: "DESC" },
        })
        if (
          !latest_trace_for_endpoint.responseHeaders.find(v =>
            v.name.includes("Strict-Transport-Security"),
          )
        ) {
          try {
            let options_req = await axios.options(
              new URL(
                `http://${latest_trace_for_endpoint.host}${latest_trace_for_endpoint.path}`,
              ).href,
              {
                validateStatus: code => true,
              },
            )
            console.log(options_req.headers)
            if (
              !Object.keys(options_req.headers).includes(
                "Strict-Transport-Security",
              )
            ) {
              alertableData.push([
                endpoint,
                latest_trace_for_endpoint,
                `Found endpoint possibly missing SSL on ${endpoint.path}`,
              ])
            }
          } catch (err) {
            console.log(
              `Couldn't perform OPTIONS request for endpoint ${endpoint.host}${endpoint.path}: ${err.message}`,
            )
          }
        }
      }
      let alerts = await AlertService.createMissingHSTSAlert(alertableData)
      await alertsRepository.save(alerts)
    } catch (err) {
      console.error(
        `Encountered error while looking for HSTS enabled endpoints : ${err}`,
      )
    }
  }
}
