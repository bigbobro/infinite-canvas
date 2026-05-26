package handler

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/google/uuid"
)

const referenceMediaMaxBytes = 80 << 20

type referenceMediaUploadResult struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
}

func UploadReferenceMedia(w http.ResponseWriter, r *http.Request) {
	publicBaseURL := strings.TrimRight(strings.TrimSpace(config.Cfg.PublicBaseURL), "/")
	if publicBaseURL == "" {
		Fail(w, "未配置 PUBLIC_BASE_URL，无法把本地参考视频提供给火山方舟访问")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, referenceMediaMaxBytes+1)
	if err := r.ParseMultipartForm(referenceMediaMaxBytes); err != nil {
		Fail(w, "参考素材过大或上传格式不正确")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请上传参考图片或视频")
		return
	}
	defer file.Close()

	mimeType, ext, ok := normalizeReferenceMediaType(header.Header.Get("Content-Type"), filepath.Ext(header.Filename))
	if !ok {
		Fail(w, "参考素材格式不支持，请使用 jpeg/png/webp/bmp/gif/heic/heif 图片或 mp4/mov 视频")
		return
	}
	if err := os.MkdirAll(referenceMediaDir(), 0o755); err != nil {
		Fail(w, "参考素材保存失败")
		return
	}
	id := uuid.NewString() + ext
	targetPath := filepath.Join(referenceMediaDir(), id)
	target, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		Fail(w, "参考素材保存失败")
		return
	}
	bytes, copyErr := io.Copy(target, file)
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(targetPath)
		Fail(w, "参考素材保存失败")
		return
	}
	if bytes <= 0 || bytes > referenceMediaMaxBytes {
		_ = os.Remove(targetPath)
		Fail(w, "参考素材为空或超过大小限制")
		return
	}
	OK(w, referenceMediaUploadResult{
		ID:       id,
		URL:      fmt.Sprintf("%s/api/media/references/%s", publicBaseURL, id),
		MimeType: mimeType,
		Bytes:    bytes,
	})
}

func ReferenceMedia(w http.ResponseWriter, r *http.Request, id string) {
	if id == "" || id != filepath.Base(id) || strings.Contains(id, "..") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(referenceMediaDir(), id)
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if mimeType := mimeTypeByReferenceMediaExt(filepath.Ext(id)); mimeType != "" {
		w.Header().Set("Content-Type", mimeType)
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeContent(w, r, id, info.ModTime(), file)
}

func referenceMediaDir() string {
	return filepath.Join("data", "reference-media")
}

func normalizeReferenceMediaType(contentType string, ext string) (string, string, bool) {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	ext = strings.ToLower(strings.TrimSpace(ext))
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = mimeTypeByReferenceMediaExt(ext)
	}
	if fixedExt := referenceMediaExtByMimeType(contentType); fixedExt != "" {
		return contentType, fixedExt, true
	}
	if mimeType := mimeTypeByReferenceMediaExt(ext); mimeType != "" {
		return mimeType, ext, true
	}
	return "", "", false
}

func referenceMediaExtByMimeType(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	case "image/gif":
		return ".gif"
	case "image/heic":
		return ".heic"
	case "image/heif":
		return ".heif"
	case "video/mp4":
		return ".mp4"
	case "video/quicktime", "video/mov":
		return ".mov"
	default:
		return ""
	}
}

func mimeTypeByReferenceMediaExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".gif":
		return "image/gif"
	case ".heic":
		return "image/heic"
	case ".heif":
		return "image/heif"
	case ".mp4":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	default:
		return ""
	}
}
