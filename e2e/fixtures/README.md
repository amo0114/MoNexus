`product-video.mp4` is a generated one-second blue H.264/yuv420p fixture (320 × 240, 25 fps) with a synthetic 440 Hz AAC-LC mono audio track and the MP4 index at the start. It contains no third-party content. The video journey plays it to the end with sound unmuted in the review dialog; actual device/speaker compatibility still requires release acceptance.

Regenerate with FFmpeg:

```bash
ffmpeg -f lavfi -i color=c=blue:s=320x240:r=25 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 1 -c:v libx264 -pix_fmt yuv420p -threads 1 -c:a aac -profile:a aac_low -ac 1 -movflags +faststart product-video.mp4
```
