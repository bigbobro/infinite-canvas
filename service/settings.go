package service

import (
	"errors"
	"math/rand"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func PublicSettings() (model.PublicSetting, error) {
	settings, err := repository.GetSettings()
	return normalizePublicSetting(settings.Public), err
}

func AdminSettings() (model.Settings, error) {
	settings, err := repository.GetSettings()
	return normalizeSettings(settings), err
}

func SaveSettings(settings model.Settings) (model.Settings, error) {
	return repository.SaveSettings(normalizeSettings(settings), now())
}

func normalizeSettings(settings model.Settings) model.Settings {
	settings.Public = normalizePublicSetting(settings.Public)
	settings.Private = normalizePrivateSetting(settings.Private)
	return settings
}

func normalizePublicSetting(setting model.PublicSetting) model.PublicSetting {
	if setting.ModelChannel.AvailableModels == nil {
		setting.ModelChannel.AvailableModels = []string{}
	}
	if setting.ModelChannel.AllowCustomChannel == nil {
		enabled := true
		setting.ModelChannel.AllowCustomChannel = &enabled
	}
	return setting
}

func normalizePrivateSetting(setting model.PrivateSetting) model.PrivateSetting {
	if setting.Channels == nil {
		setting.Channels = []model.ModelChannel{}
	}
	for i := range setting.Channels {
		if setting.Channels[i].Protocol == "" {
			setting.Channels[i].Protocol = "openai"
		}
		if setting.Channels[i].Models == nil {
			setting.Channels[i].Models = []string{}
		}
		if setting.Channels[i].Weight <= 0 {
			setting.Channels[i].Weight = 1
		}
	}
	return setting
}

func SelectModelChannel(modelName string) (model.ModelChannel, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.ModelChannel{}, err
	}
	channels := modelChannelsForModel(normalizePrivateSetting(settings.Private).Channels, modelName)
	if len(channels) == 0 {
		return model.ModelChannel{}, errors.New("没有可用模型渠道")
	}
	total := 0
	for _, channel := range channels {
		total += channel.Weight
	}
	hit := rand.Intn(total)
	for _, channel := range channels {
		hit -= channel.Weight
		if hit < 0 {
			return channel, nil
		}
	}
	return channels[0], nil
}

func BuildModelChannelURL(channel model.ModelChannel, path string) string {
	baseURL := strings.TrimRight(channel.BaseURL, "/")
	if !strings.HasSuffix(baseURL, "/v1") {
		baseURL += "/v1"
	}
	return baseURL + path
}

func modelChannelsForModel(channels []model.ModelChannel, modelName string) []model.ModelChannel {
	result := []model.ModelChannel{}
	for _, channel := range channels {
		if !channel.Enabled || channel.BaseURL == "" || channel.APIKey == "" {
			continue
		}
		for _, item := range channel.Models {
			if strings.TrimSpace(item) == modelName {
				result = append(result, channel)
				break
			}
		}
	}
	return result
}
