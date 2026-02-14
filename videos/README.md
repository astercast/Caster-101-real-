# WTV Video Files

Place your video files in this folder with these exact names:

1. `sprout-magic.mp4`
2. `a-wizard.mp4`
3. `hear-the-drums.mp4`
4. `keys-fall-slow.mp4`
5. `caster.mp4`

## Instructions

1. Download your NFT videos from MintGarden or your local source
2. Rename them to match the filenames above
3. Place them in this `videos/` folder
4. The WTV miniplayer will automatically load and play them

## File Size Considerations

- Videos will be committed to Git and deployed to Vercel
- Keep file sizes reasonable (under 50MB each ideally)
- Vercel has a 100MB deployment size limit for free tier
- Consider compressing videos if they're too large

## Alternative: Keep Videos Local Only

If you want to keep videos local (not commit to Git):
1. Add `videos/*.mp4` to `.gitignore`
2. Videos will only work when running the site locally
3. On deployed version, you'll need to host videos elsewhere
