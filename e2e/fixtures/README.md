`product-video.mp4` is a generated one-second silent blue H.264/yuv420p fixture (320 × 240, 25 fps), with the MP4 index at the start. It contains no third-party content.

Regenerate with FFmpeg:

```bash
ffmpeg -f lavfi -i color=c=blue:s=320x240:r=25 -t 1 -c:v libx264 -pix_fmt yuv420p -threads 1 -movflags +faststart product-video.mp4
```
