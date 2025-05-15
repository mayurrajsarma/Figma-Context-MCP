import fs from "fs";
import { parseFigmaResponse, type SimplifiedDesign } from "./simplify-node-response.js";
import type {
  GetImagesResponse,
  GetFileResponse,
  GetFileNodesResponse,
  GetImageFillsResponse,
} from "@figma/rest-api-spec";
import { downloadFigmaImage } from "~/utils/common.js";
import { Logger } from "~/utils/logger.js";
import yaml from "js-yaml";

export interface FigmaError {
  status: number;
  err: string;
}

type FetchImageParams = {
  /**
   * The Node in Figma that will either be rendered or have its background image downloaded
   */
  nodeId: string;
  /**
   * The local file name to save the image
   */
  fileName: string;
  /**
   * The file mimetype for the image
   */
  fileType: "png" | "svg";
};

type FetchImageFillParams = Omit<FetchImageParams, "fileType"> & {
  
  /**
   * type FetchImageParams = {
    nodeId: string;
    fileName: string;
    fileType: "png" | "svg"; we remove this and add imageRef
  }
   * Required to grab the background image when an image is used as a fill
   */
  imageRef: string;//imageRef is a Figma-generated ID that uniquely identifies an image fill (a bitmap used as a fill background in Figma).
};

export class FigmaService {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.figma.com/v1";

  constructor(apiKey: string) { //When you do new FigmaService(figmaApiKey), this constructor runs.
    this.apiKey = apiKey;
  }


  //Every public method (getFile, getNode, etc.) uses this to talk to Figma.
  private async request<T>(endpoint: string): Promise<T> { //This method wraps a fetch call to the Figma API
    if (typeof fetch !== "function") {//Checks if fetch is available in the current runtime. (Some older Node.js versions don’t support fetch natively.)
      throw new Error(
        "The MCP server is being run in a Node.js environment where `fetch` is not available. You won't be able to access any data related to the Figma file.\n\nAs the coding AI assistant, PLEASE ABORT THE CURRENT REQUEST. No alternate approaches will work. Help the user fix this issue so you can proceed by letting them know that they need to run the MCP server with Node.js version 18 or higher.",
      );
    }
    try {
      Logger.log(`Calling ${this.baseUrl}${endpoint}`);
      const response = await fetch(`${this.baseUrl}${endpoint}`, {// makes the request
        headers: {
          "X-Figma-Token": this.apiKey,
        },
      });

      if (!response.ok) {
        throw {
          status: response.status,
          err: response.statusText || "Unknown error",
        } as FigmaError;
      }

      return await response.json();
    } catch (error) {
      if ((error as FigmaError).status) {
        throw error;
      }
      if (error instanceof Error) {
        throw new Error(`Failed to make request to Figma API: ${error.message}`);
      }
      throw new Error(`Failed to make request to Figma API: ${error}`);
    }
  }

  async getImageFills(
    fileKey: string,
    nodes: FetchImageFillParams[],
    localPath: string,
  ): Promise<string[]> {
    if (nodes.length === 0) return [];

    let promises: Promise<string>[] = [];
    const endpoint = `/files/${fileKey}/images`;
    const file = await this.request<GetImageFillsResponse>(endpoint); // request
    const { images = {} } = file.meta;// Destructures the images object from file.meta.
    promises = nodes.map(async ({ imageRef, fileName }) => { // Maps over each node and returns a promise to download that node’s image.
      const imageUrl = images[imageRef];
      if (!imageUrl) {
        return "";
      }
      return downloadFigmaImage(fileName, localPath, imageUrl);
    });
    return Promise.all(promises);//Returns an array of strings (each one being a saved file name or empty string if failed).
    //dummy return
    // [
    //   "icon-home.png",
    //   "logo.svg",
    //   "",                // this one failed (no imageRef match)
    //   "background.png"
    // ]
    
  }

  async getImages(
    fileKey: string,
    nodes: FetchImageParams[],
    localPath: string,
  ): Promise<string[]> {
    //we Separate out PNG nodes
    //pngIds = ["12:34", "56:78", "90:12"];
    const pngIds = nodes.filter(({ fileType }) => fileType === "png").map(({ nodeId }) => nodeId);
    
    //Request PNG image URLs from Figma API
    const pngFiles =
      pngIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${pngIds.join(",")}&scale=2&format=png`,//`/images/AbC123?ids=12:34,56:78,90:12&scale=2&format=png`
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    const svgIds = nodes.filter(({ fileType }) => fileType === "svg").map(({ nodeId }) => nodeId);
    const svgFiles =
      svgIds.length > 0
        ? this.request<GetImagesResponse>(
            `/images/${fileKey}?ids=${svgIds.join(",")}&format=svg`,
          ).then(({ images = {} }) => images)
        : ({} as GetImagesResponse["images"]);

    //Merge PNG and SVG URL maps into one object
    const files = await Promise.all([pngFiles, svgFiles]).then(([f, l]) => ({ ...f, ...l }));
          //dummy file below
          // files = {
          //    "nodeId": "imageUrl",      
          //   "1:2": "https://figma.com/logo.png",
          //   "3:4": "https://figma.com/icon.svg"
          // }
    const downloads = nodes
      .map(({ nodeId, fileName }) => {
        const imageUrl = files[nodeId];
        if (imageUrl) {
          return downloadFigmaImage(fileName, localPath, imageUrl);
        }
        return false;
      })
      .filter((url) => !!url);//removes the falsy entries.



    return Promise.all(downloads);
  }

  //Fetches a full Figma file by fileKey. Optionally uses depth to control how deep the tree is fetched. Calls:
  async getFile(fileKey: string, depth?: number | null): Promise<SimplifiedDesign> {
    try {
      const endpoint = `/files/${fileKey}${depth ? `?depth=${depth}` : ""}`;
      Logger.log(`Retrieving Figma file: ${fileKey} (depth: ${depth ?? "default"})`);//?? to print "default" if depth is null or undefined.
      const response = await this.request<GetFileResponse>(endpoint); //JSON response
      Logger.log("Got response");
      const simplifiedResponse = parseFigmaResponse(response); 
      writeLogs("figma-raw.yml", response);//Only happens in development mode (as defined in the writeLogs function).
      writeLogs("figma-simplified.yml", simplifiedResponse);
      return simplifiedResponse;
    } catch (e) {
      console.error("Failed to get file:", e);
      throw e;
    }
  }

  async getNode(fileKey: string, nodeId: string, depth?: number | null): Promise<SimplifiedDesign> {
    const endpoint = `/files/${fileKey}/nodes?ids=${nodeId}${depth ? `&depth=${depth}` : ""}`;
    const response = await this.request<GetFileNodesResponse>(endpoint);
    Logger.log("Got response from getNode, now parsing.");
    writeLogs("figma-raw.yml", response);
    const simplifiedResponse = parseFigmaResponse(response);
    writeLogs("figma-simplified.yml", simplifiedResponse);
    return simplifiedResponse;
  }
}

function writeLogs(name: string, value: any) {
  try {
    if (process.env.NODE_ENV !== "development") return;

    const logsDir = "logs";

    try {
      fs.accessSync(process.cwd(), fs.constants.W_OK);
    } catch (error) {
      Logger.log("Failed to write logs:", error);
      return;
    }

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir);
    }
    fs.writeFileSync(`${logsDir}/${name}`, yaml.dump(value));
  } catch (error) {
    console.debug("Failed to write logs:", error);
  }
}
