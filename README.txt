Moleratbot YouTube playback fix

What changed:
- play-dl is still used for YouTube search results.
- @distube/ytdl-core is now used for the actual audio stream in playNextSong().
- This fixes the Railway log error: TypeError [ERR_INVALID_URL]: Invalid URL input: undefined from play-dl.stream().

How to install:
1. Replace discord_bot.js and package.json in your Railway/GitHub project with these files.
2. Commit/push or redeploy.
3. In Railway logs, confirm: ✅ Music dependencies loaded
4. In Discord music channel, use /join, then !play <song name> or /play <url>.

Expected logs:
- Text search result should still show a YouTube URL.
- Attempting to play should show that same URL.
- No more play-dl stream_from_info ERR_INVALID_URL input undefined.
