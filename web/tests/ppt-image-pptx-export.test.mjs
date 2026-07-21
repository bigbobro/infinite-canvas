import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { strFromU8, unzipSync } from "fflate";
import { createServer } from "vite";

let vite;
let imagePptx;

const PNG_BYTES = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const JPEG_BYTES = Uint8Array.from(
    Buffer.from(
        "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD9DKKKKAP/2Q==",
        "base64",
    ),
);

before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
    imagePptx = await vite.ssrLoadModule("/src/lib/ppt/image-pptx-export.ts");
});

after(async () => {
    await vite?.close();
});

test("16:9 与 4:3 统一页面比例均通过检查", () => {
    assert.deepEqual(imagePptx.findMixedImagePptxPages([page(1, 1600, 900), page(2, 1920, 1080)]), []);
    assert.deepEqual(imagePptx.findMixedImagePptxPages([page(1, 1200, 900), page(2, 1600, 1200)]), []);
});

test("0.5% 相对容差边界内通过，超出时返回异常页码", () => {
    const pages = [page(1, 1000, 1000), page(2, 1005, 1000), page(3, 1006, 1000)];
    assert.deepEqual(imagePptx.findMixedImagePptxPages(pages), [3]);
});

test("混合比例以输入首页为基准并列出全部异常页", () => {
    const pages = [page(1, 1600, 900), page(2, 1200, 900), page(3, 1920, 1080), page(4, 1024, 768)];
    assert.deepEqual(imagePptx.findMixedImagePptxPages(pages), [2, 4]);
});

test("混合比例在加载 PPTX 依赖前阻止并列出页码", async () => {
    await assert.rejects(imagePptx.createImagePptxBytes([page(1, 1600, 900), page(2, 1200, 900), page(3, 1024, 768)]), /第 2、3 页/);
});

test("16:9 和 4:3 分别生成同比例的自定义 PPT 布局", async (context) => {
    for (const item of [
        { name: "16:9", width: 1600, height: 900 },
        { name: "4:3", width: 1200, height: 900 },
    ]) {
        await context.test(item.name, async () => {
            const bytes = await imagePptx.createImagePptxBytes([page(1, item.width, item.height)]);
            const files = unzipSync(bytes);
            const presentation = strFromU8(files["ppt/presentation.xml"]);
            const size = presentation.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
            assert.ok(size);
            assert.ok(Math.abs(Number(size[1]) / Number(size[2]) - item.width / item.height) < 0.00001);
        });
    }
});

test("21 页按输入顺序生成，进度、slide 与 media 一一对应", async () => {
    const pages = Array.from({ length: 21 }, (_, index) => page(21 - index, 1600, 900, index + 1));
    const progress = [];
    const bytes = await imagePptx.createImagePptxBytes(pages, { onProgress: (item) => progress.push(item) });
    const files = unzipSync(bytes);
    const slideNames = Object.keys(files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    const mediaNames = Object.keys(files).filter((name) => /^ppt\/media\/[^/]+$/.test(name));

    assert.equal(slideNames.length, 21);
    assert.equal(mediaNames.length, 21);
    assert.deepEqual(
        progress,
        pages.map((item, index) => ({ pageNumber: item.pageNumber, completed: index + 1, total: pages.length })),
    );

    pages.forEach((item, index) => {
        const slideNumber = index + 1;
        const slide = strFromU8(files[`ppt/slides/slide${slideNumber}.xml`]);
        assert.match(slide, new RegExp(`descr="第 ${item.pageNumber} 页"`));

        const relationships = strFromU8(files[`ppt/slides/_rels/slide${slideNumber}.xml.rels`]);
        const target = relationships.match(/Target="\.\.\/media\/([^"]+)"/)?.[1];
        assert.ok(target);
        assert.equal(files[`ppt/media/${target}`].at(-1), index + 1);
    });
});

test("每页只含一张全幅图，不含文字或裁切", async () => {
    const files = unzipSync(await imagePptx.createImagePptxBytes([page(1, 1600, 900)]));
    const presentation = strFromU8(files["ppt/presentation.xml"]);
    const slide = strFromU8(files["ppt/slides/slide1.xml"]);
    const slideSize = presentation.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
    const imageSizes = [...slide.matchAll(/<a:off x="0" y="0"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)].map((match) => match.slice(1));

    assert.ok(slideSize);
    assert.ok(imageSizes.some((size) => size[0] === slideSize[1] && size[1] === slideSize[2]));
    assert.equal((slide.match(/<p:pic>/g) || []).length, 1);
    assert.doesNotMatch(slide, /<a:t>/);
    assert.doesNotMatch(slide, /<a:srcRect/);
    assert.match(slide, /<a:stretch><a:fillRect\/><\/a:stretch>/);
});

test("PNG/JPEG 按魔数识别并保留原始字节", async () => {
    const pages = [
        { pageNumber: 1, width: 1600, height: 900, blob: new Blob([PNG_BYTES], { type: "application/octet-stream" }) },
        { pageNumber: 2, width: 1600, height: 900, blob: new Blob([JPEG_BYTES], { type: "image/webp" }) },
    ];
    const files = unzipSync(await imagePptx.createImagePptxBytes(pages));
    const firstTarget = mediaTarget(files, 1);
    const secondTarget = mediaTarget(files, 2);

    assert.match(firstTarget, /\.png$/);
    assert.match(secondTarget, /\.jpe?g$/);
    assert.deepEqual(files[`ppt/media/${firstTarget}`], PNG_BYTES);
    assert.deepEqual(files[`ppt/media/${secondTarget}`], JPEG_BYTES);
});

test("Blob 接口返回正确 PPTX MIME 与内容", async () => {
    const blob = await imagePptx.createImagePptxBlob([page(1, 1600, 900)]);
    assert.equal(blob.type, imagePptx.IMAGE_PPTX_MIME_TYPE);
    assert.ok(blob.size > 0);
    assert.ok(unzipSync(new Uint8Array(await blob.arrayBuffer()))["ppt/presentation.xml"]);
});

function page(pageNumber, width, height, marker = pageNumber) {
    const bytes = new Uint8Array(PNG_BYTES.length + 1);
    bytes.set(PNG_BYTES);
    bytes[bytes.length - 1] = marker;
    return { pageNumber, width, height, blob: new Blob([bytes], { type: "image/png" }) };
}

function mediaTarget(files, slideNumber) {
    const relationships = strFromU8(files[`ppt/slides/_rels/slide${slideNumber}.xml.rels`]);
    const target = relationships.match(/Target="\.\.\/media\/([^"]+)"/)?.[1];
    assert.ok(target);
    return target;
}
