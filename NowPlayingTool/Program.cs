using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NPSMLib;

// A standalone tool to get the current media track from Windows.
// Combines all necessary classes into one file for simplicity.
namespace NowPlayingTool
{
    public class Program
    {
        public static async Task Main(string[] args)
        {
            var service = new NpsmNowPlayingService();
            var tcs = new TaskCompletionSource<NowPlayingEventArgs>();

            service.NowPlayingTrackChanged += (sender, track) =>
            {
                // We only want the first result, then we exit.
                tcs.TrySetResult(track);
            };

            service.Start();

            // Wait for a result for a maximum of 5 seconds.
            var task = await Task.WhenAny(tcs.Task, Task.Delay(5000));

            if (task == tcs.Task)
            {
                var result = tcs.Task.Result;
                if (result != null)
                {
                    var json = JsonConvert.SerializeObject(result);
                    Console.WriteLine(json);
                }
            }
            // If the task is a delay, it means no track was found in 5 seconds,
            // and the program will exit silently.
            
            service.Stop();
        }
    }

    // Data model for the currently playing track.
    public class NowPlayingEventArgs : EventArgs
    {
        public string AlbumArtist { get; set; }
        public string AlbumTitle { get; set; }
        public int AlbumTrackCount { get; set; }
        public string Artist { get; set; }
        public List<string> Genres { get; set; }
        public string PlaybackType { get; set; }
        public string Subtitle { get; set; }
        public string Thumbnail { get; set; } // Base64 encoded image
        public string Title { get; set; }
        public int TrackNumber { get; set; }
    }

    // Service to interact with the Windows Now Playing Session Manager.
    public class NpsmNowPlayingService
    {
        public event EventHandler<NowPlayingEventArgs> NowPlayingTrackChanged;

        private static readonly bool isWindows11_OrGreater = Environment.OSVersion.Version.Build >= 22000;
        private readonly NowPlayingSessionManager manager = new NowPlayingSessionManager();
        private static readonly object lockObject = new object();
        private MediaPlaybackDataSource src;
        private NowPlayingSession session;
        private NowPlayingEventArgs model;

        public NpsmNowPlayingService() { }

        public void Start()
        {
            manager.SessionListChanged += SessionListChanged;
            SessionListChanged(null, null);
        }

        public void Stop()
        {
            manager.SessionListChanged -= SessionListChanged;
        }

        private void SessionListChanged(object sender, NowPlayingSessionManagerEventArgs e)
        {
            session = manager.CurrentSession;
            SetupEvents();
            UpdateMedia();
        }

        private void SetupEvents()
        {
            if (session is not null)
            {
                src = session.ActivateMediaPlaybackDataSource();
                src.MediaPlaybackDataChanged += MediaPlaybackDataChanged;
            }
        }

        private void MediaPlaybackDataChanged(object sender, MediaPlaybackDataChangedArgs e) => UpdateMedia();

        private void UpdateMedia()
        {
            if (session != null)
            {
                lock (lockObject)
                {
                    try
                    {
                        var media = src.GetMediaObjectInfo();
                        var mediaPlaybackInfo = src.GetMediaPlaybackInfo();
                        using var thumbnail = src.GetThumbnailStream();
                        var thumbnailString = thumbnail is null ? null : CreateThumbnail(thumbnail);

                        switch (mediaPlaybackInfo.PlaybackState)
                        {
                            case MediaPlaybackState.Playing:
                            case MediaPlaybackState.Changing:
                            case MediaPlaybackState.Opened:
                            case MediaPlaybackState.Paused:
                                {
                                    if (string.IsNullOrEmpty(media.Title))
                                    {
                                        model = null;
                                        NowPlayingTrackChanged?.Invoke(this, model);
                                        break;
                                    }

                                    var newModel = new NowPlayingEventArgs
                                    {
                                        AlbumArtist = media.AlbumArtist,
                                        AlbumTitle = media.AlbumTitle,
                                        AlbumTrackCount = (int)media.AlbumTrackCount,
                                        Artist = media.Artist,
                                        Genres = media.Genres?.ToList(),
                                        PlaybackType = MediaPlaybackDataSource.MediaSchemaToMediaPlaybackMode(media.MediaClassPrimaryID).ToString(),
                                        Subtitle = media.Subtitle,
                                        Thumbnail = thumbnailString,
                                        Title = media.Title,
                                        TrackNumber = (int)media.TrackNumber
                                    };

                                    model = newModel;
                                    NowPlayingTrackChanged?.Invoke(this, model);
                                }
                                break;
                            case MediaPlaybackState.Closed:
                            case MediaPlaybackState.Stopped:
                            case MediaPlaybackState.Unknown:
                                model = null;
                                NowPlayingTrackChanged?.Invoke(this, model);
                                break;
                        }
                    }
                    catch (Exception ex)
                    {
                        Debug.WriteLine(ex);
                        model = null;
                        NowPlayingTrackChanged?.Invoke(this, model);
                    }
                }
            }
            else
            {
                lock (lockObject)
                {
                    model = null;
                    NowPlayingTrackChanged?.Invoke(this, model);
                }
            }
        }

        private static string CreateThumbnail(Stream stream)
        {
            using var ms = new MemoryStream();
            ms.Seek(0, SeekOrigin.Begin);
            stream.CopyTo(ms);
            if (!isWindows11_OrGreater)
            {
                using var bmp = new Bitmap(ms);
                if (IsPixelAlpha(bmp, 0, 0))
                    return CropImage(bmp, 34, 1, 233, 233);
            }
            var array = ms.ToArray();
            return Convert.ToBase64String(array);
        }

        private static string CropImage(Bitmap bmp, int x, int y, int width, int height)
        {
            var rect = new Rectangle(x, y, width, height);
            using var croppedBitmap = new Bitmap(rect.Width, rect.Height, bmp.PixelFormat);
            var gfx = Graphics.FromImage(croppedBitmap);
            gfx.DrawImage(bmp, 0, 0, rect, GraphicsUnit.Pixel);
            using var ms = new MemoryStream();
            croppedBitmap.Save(ms, ImageFormat.Png);
            byte[] byteImage = ms.ToArray();
            return Convert.ToBase64String(byteImage);
        }

        private static bool IsPixelAlpha(Bitmap bmp, int x, int y) => bmp.GetPixel(x, y).A == 0;
    }
}
