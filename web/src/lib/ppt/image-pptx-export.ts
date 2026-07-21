export const IMAGE_PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const IMAGE_PPTX_RATIO_TOLERANCE = 0.005;

export type ImagePptxPage = {
    pageNumber: number;
    blob: Blob;
    width: number;
    height: number;
};

export type ImagePptxProgress = {
    pageNumber: number;
    completed: number;
    total: number;
};

export type ImagePptxOptions = {
    onProgress?: (progress: ImagePptxProgress) => void;
};

const SLIDE_HEIGHT_INCHES = 7.5;

type DecodedImage = {
    source: CanvasImageSource;
    width: number;
    height: number;
    dispose: () => void;
};

export function findMixedImagePptxPages(pages: readonly Pick<ImagePptxPage, "pageNumber" | "width" | "height">[], tolerance = IMAGE_PPTX_RATIO_TOLERANCE) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("PPT 页面比例容差必须是非负有限数");
    pages.forEach(assertPageDimensions);
    if (pages.length < 2) return [];

    const referenceRatio = pages[0].width / pages[0].height;
    return pages
        .slice(1)
        .filter((page) => Math.abs(page.width / page.height - referenceRatio) / referenceRatio > tolerance + Number.EPSILON * 16)
        .map((page) => page.pageNumber);
}

export async function createImagePptxBytes(pages: readonly ImagePptxPage[], options: ImagePptxOptions = {}): Promise<Uint8Array> {
    if (!pages.length) throw new Error("至少需要一页图片才能生成 PPT");
    const mixedPages = findMixedImagePptxPages(pages);
    if (mixedPages.length) throw new Error(`PPT 页面比例不一致：第 ${mixedPages.join("、")} 页`);

    const preparedPages: Array<{ pageNumber: number; data: string }> = [];
    for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        preparedPages.push({ pageNumber: page.pageNumber, data: await imageBlobToPptxData(page) });
        options.onProgress?.({ pageNumber: page.pageNumber, completed: index + 1, total: pages.length });
    }

    const { default: PptxGenJS } = await import("pptxgenjs");
    const pptx = new PptxGenJS();
    const ratio = pages[0].width / pages[0].height;
    const slideWidth = SLIDE_HEIGHT_INCHES * ratio;
    const layoutName = "IMAGE_PPTX_LAYOUT";
    pptx.defineLayout({ name: layoutName, width: slideWidth, height: SLIDE_HEIGHT_INCHES });
    pptx.layout = layoutName;

    for (const page of preparedPages) {
        const slide = pptx.addSlide();
        slide.addImage({ data: page.data, x: 0, y: 0, w: slideWidth, h: SLIDE_HEIGHT_INCHES, altText: `第 ${page.pageNumber} 页` });
    }

    const output = await pptx.write({ outputType: "uint8array", compression: true });
    if (!(output instanceof Uint8Array)) throw new Error("PPT 文件生成失败");
    return output;
}

export async function createImagePptxBlob(pages: readonly ImagePptxPage[], options: ImagePptxOptions = {}) {
    const bytes = await createImagePptxBytes(pages, options);
    const buffer = new Uint8Array(bytes.byteLength);
    buffer.set(bytes);
    return new Blob([buffer.buffer], { type: IMAGE_PPTX_MIME_TYPE });
}

export async function readImagePptxDimensions(pageNumber: number, blob: Blob) {
    const decoded = await decodeImageBlob(pageNumber, blob);
    try {
        return { width: decoded.width, height: decoded.height };
    } finally {
        decoded.dispose();
    }
}

function assertPageDimensions(page: Pick<ImagePptxPage, "pageNumber" | "width" | "height">) {
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
        throw new Error(`第 ${page.pageNumber} 页的图片尺寸无效`);
    }
}

async function imageBlobToPptxData(page: ImagePptxPage) {
    const mimeType = await detectNativeImageMimeType(page.blob);
    if (mimeType) return blobToDataUrl(page.blob, mimeType);
    return blobToDataUrl(await convertImageBlobToPng(page), "image/png");
}

async function convertImageBlobToPng(page: ImagePptxPage) {
    if (typeof document === "undefined") {
        throw new Error(`第 ${page.pageNumber} 页的图片格式需要在浏览器中转换为 PNG`);
    }

    const decoded = await decodeImageBlob(page.pageNumber, page.blob);
    const canvas = document.createElement("canvas");
    try {
        canvas.width = decoded.width;
        canvas.height = decoded.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error(`第 ${page.pageNumber} 页无法创建图片转换画布`);
        context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
        return await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`第 ${page.pageNumber} 页无法转换为 PNG`))), "image/png");
        });
    } finally {
        canvas.width = 0;
        canvas.height = 0;
        decoded.dispose();
    }
}

async function detectNativeImageMimeType(blob: Blob): Promise<"image/png" | "image/jpeg" | null> {
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    return null;
}

async function decodeImageBlob(pageNumber: number, blob: Blob): Promise<DecodedImage> {
    if (typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(blob);
            if (bitmap.width > 0 && bitmap.height > 0) return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
            bitmap.close();
        } catch {
            // Safari 对部分格式的 createImageBitmap 支持较弱，继续用 Image 解码。
        }
    }
    if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") throw new Error(`第 ${pageNumber} 页的图片无法解码`);

    const objectUrl = URL.createObjectURL(blob);
    try {
        const image = await loadImage(objectUrl, pageNumber);
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error(`第 ${pageNumber} 页的图片无法解码`);
        return { source: image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => URL.revokeObjectURL(objectUrl) };
    } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
    }
}

function loadImage(url: string, pageNumber: number) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`第 ${pageNumber} 页的图片无法解码`));
        image.src = url;
    });
}

async function blobToDataUrl(blob: Blob, mimeType: string) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
}
