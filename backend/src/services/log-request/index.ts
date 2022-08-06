import { Raw } from "typeorm";
import { PairObject, TraceParams } from "../../types";
import { ApiEndpoint, ApiTrace, MatchedDataClass } from "../../../models";
import { AppDataSource } from "../../data-source";
import { ScannerService } from "../scanner/scan";
import { DataClass } from "../../enums";
import Error500InternalServer from "../../errors/error-500-internal-server";

export class LogRequestService {
  static matchExists(
    matchedDataClasses: MatchedDataClass[],
    dataPath: string,
    dataClass: DataClass
  ): boolean {
    for (let i = 0; i < matchedDataClasses.length; i++) {
      const curr = matchedDataClasses[i];
      if (curr.dataClass === dataClass && curr.dataPath === dataPath) {
        return true;
      }
    }
    return false;
  }

  static findMatchedDataClasses(
    dataPathPrefix: string,
    data: PairObject[],
    apiEndpoint: ApiEndpoint
  ) {
    try {
      if (data) {
        for (const item of data) {
          const field = item.name;
          const matches = ScannerService.scan(item.value);
          Object.keys(matches).forEach(async (match) => {
            const matchDataClass = match as DataClass;
            const matchDataPath = `${dataPathPrefix}.${field}`;
            const exsistingMatch = this.matchExists(
              apiEndpoint.sensitiveDataClasses,
              matchDataPath,
              matchDataClass
            );
            if (!exsistingMatch) {
              const dataClass = new MatchedDataClass();
              dataClass.dataClass = matchDataClass;
              dataClass.dataPath = `${dataPathPrefix}.${field}`;
              dataClass.matches = matches[match];
              dataClass.apiEndpoint = apiEndpoint;
              await AppDataSource.getRepository(MatchedDataClass).save(
                dataClass
              );
            }
          });
        }
      }
    } catch (err) {
      console.error(`Error while finding matched data classes: ${err}`);
      throw new Error500InternalServer(err);
    }
  }

  static async logRequest(traceParams: TraceParams) {
    try {
      /** Log Request in ApiTrace table */
      const apiTraceRepository = AppDataSource.getRepository(ApiTrace);
      const path = traceParams?.request?.url?.path;
      const method = traceParams?.request?.method;
      const host = traceParams?.request?.url?.host;
      const requestParameters = traceParams?.request?.url?.parameters;
      const requestHeaders = traceParams?.request?.headers;
      const requestBody = traceParams?.request?.body;
      const responseHeaders = traceParams?.response?.headers;
      const responseBody = traceParams?.response?.body;
      const apiTraceObj = new ApiTrace();
      apiTraceObj.path = path;
      apiTraceObj.method = method;
      apiTraceObj.host = host;
      apiTraceObj.requestParameters = requestParameters;
      apiTraceObj.requestHeaders = requestHeaders;
      apiTraceObj.requestBody = requestBody;
      apiTraceObj.responseStatus = traceParams?.response?.status;
      apiTraceObj.responseHeaders = responseHeaders;
      apiTraceObj.responseBody = responseBody;
      apiTraceObj.meta = traceParams?.meta;

      /** Update existing endpoint record if exists */
      const apiEndpointRepository = AppDataSource.getRepository(ApiEndpoint);
      const apiEndpoint = await apiEndpointRepository.findOne({
        where: {
          pathRegex: Raw((alias) => `:path ~ ${alias}`, { path }),
          method,
          host,
        },
        relations: { sensitiveDataClasses: true },
      });
      if (apiEndpoint) {
        apiEndpoint.totalCalls += 1;
        // Check for sensitive data
        this.findMatchedDataClasses(
          "req.params",
          requestParameters,
          apiEndpoint
        );
        this.findMatchedDataClasses("req.headers", requestHeaders, apiEndpoint);
        this.findMatchedDataClasses(
          "res.headers",
          responseHeaders,
          apiEndpoint
        );
        //TODO: Check in request body and response body, might need to unmarshall the string into json to do data path properly
        apiTraceObj.apiEndpointUuid = apiEndpoint.uuid;
        await apiEndpointRepository.save(apiEndpoint);
      }
      await apiTraceRepository.save(apiTraceObj);
    } catch (err) {
      console.error(`Error in Log Request service: ${err}`);
      throw new Error500InternalServer(err);
    }
  }

  static async logRequestBatch(traceParamsBatch: TraceParams[]) {
    for (let i = 0; i < traceParamsBatch.length; i++) {
      this.logRequest(traceParamsBatch[i]);
    }
  }
}
