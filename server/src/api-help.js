export const API_HELP = `PREMIERE PRO UXP API - CHEAT SHEET (for ppro_execute_script)
Full reference: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/

YOUR CODE is the body of an async function. In scope: ppro, uxp, log(...), and helpers:
  getProject()                      -> active Project (throws if none)
  tx(project, "Undo label", () => action | action[])   -> commits actions as ONE undo step
  T(seconds) -> TickTime            secs(tickTime) -> seconds
  walk(project) -> { root, items:[{item,name,path,kind:'bin'|'clip'|'sequence',mediaPath}] }
  findItem(project, ref, kinds?)    ref = bin path, name, or media file path
  findBin(project, "A/B", create)   getSeq(project, name?)  (active by default)
  sequenceInfo(seq), listMarkers(seqOrClip), markerType("chapter")
Return any JSON-serialisable value. TickTime values serialise to seconds.

GOLDEN RULE: reads are async (await them). EDITS are "actions" created synchronously and committed
inside project.lockedAccess + project.executeTransaction - use tx() which does both.
Never await inside the tx() builder callback.

PROJECT
  ppro.Project.getActiveProject()  p.name p.path p.guid
  p.getRootItem() -> FolderItem      p.getSequences()  p.getActiveSequence()  p.setActiveSequence(s)
  p.openSequence(s)  p.save()  p.saveAs(path)
  p.importFiles(paths[], suppressUI, targetBin, asNumberedStills)
  p.createSequence(name, presetPath?)   p.createSequenceFromMedia(name, clipProjectItems[], targetBin)
  p.deleteSequence(s)
  ppro.ProjectUtils.getSelection(p) -> selection; await selection.getItems()

PROJECT ITEMS
  ppro.FolderItem.cast(item) / ppro.ClipProjectItem.cast(item)  (null if wrong type)
  folder.getItems()  folder.createBinAction(name, makeUnique)  folder.createMoveItemAction(item, newParentFolder)
  folder.createRemoveItemAction(item)  folder.createSmartBinAction(name, query)
  item.name  item.createSetNameAction(name)  item.createSetColorLabelAction(i)  item.getParentBin()
  clip.getMediaFilePath()  clip.getContentType() (C.ContentType.MEDIA | SEQUENCE)
  clip.createSubClipAction(name, T(in), T(out), hardBoundaries, {takeVideo, takeAudio})
  clip.createSetInOutPointsAction(T(in), T(out))  clip.getInPoint()/getOutPoint()
  clip.changeMediaFilePath(newPath, overrideCompat)  (relink)   clip.attachProxy(path, isHiRes, false)

SEQUENCES
  s.name s.guid  s.getEndTime() s.getInPoint() s.getOutPoint() s.getPlayerPosition() s.setPlayerPosition(T)
  s.getFrameSize() -> {width,height}  s.getTimebase()  s.getSettings()
  s.getVideoTrackCount() s.getVideoTrack(i)  s.getAudioTrackCount() s.getAudioTrack(i)  s.getCaptionTrackCount()
  s.createSetInPointAction(T) s.createSetOutPointAction(T)
  track.getTrackItems(C.TrackItemType.CLIP, false) -> track items (sync)   track.setMute(bool)
  trackItem: getName() getStartTime() getEndTime() getInPoint() getOutPoint() getProjectItem() getSpeed()
             createMoveAction(T) createSetStartAction(T) createSetEndAction(T)
             createSetInPointAction(T) createSetOutPointAction(T) createSetDisabledAction(bool) createSetNameAction(n)
             getComponentChain() (effects)

EDITING (SequenceEditor)
  const ed = ppro.SequenceEditor.getEditor(seq)
  ed.createOverwriteItemAction(projectItem, T(time), videoTrackIndex, audioTrackIndex)
  ed.createInsertProjectItemAction(projectItem, T(time), vIdx, aIdx, limitShift)
  ed.createCloneTrackItemAction(trackItem, T(offset), vOffset, aOffset, alignToVideo, isInsert)
  ppro.TrackItemSelection.createEmptySelection(sel => { sel.addItem(trackItem) ... })   (sync callback)
  ed.createRemoveItemsAction(selection, ripple, C.MediaType.ANY, shiftOverlapping)
  ed.insertMogrtFromPath(mogrtPath, T(time), vIdx, aIdx)

MARKERS
  const m = await ppro.Markers.getMarkers(seqOrClip)
  m.getMarkers() -> Marker[] (getName getType getStart getDuration getComments getColorIndex)
  m.createAddMarkerAction(name, markerType("chapter"), T(start), T(duration), comments)
  m.createRemoveMarkerAction(marker)   marker.createSetColorByIndexAction(i)  marker.createSetCommentsAction(s)

EXPORT
  ppro.Exporter.exportSequenceFrame(seq, T(time), "file.png", "/dir/", w, h)
  const em = await ppro.EncoderManager.getManager(); em.isAMEInstalled
  em.exportSequence(seq, C.ExportType.IMMEDIATELY | QUEUE_TO_AME, outFile, presetEpr, exportFull)
  em.startBatchEncode()

TRANSCRIPTS (built-in Speech to Text)
  ppro.Transcript.transcribeClipProjectItem(clip, {language:"en-US"})  ppro.Transcript.exportToJSON(clip)

EXAMPLE - rename every clip in bin "Footage" with a prefix:
  const p = await getProject();
  const bin = await findBin(p, "Footage", false);
  const items = await bin.getItems();
  tx(p, "Prefix names", () => items.map(i => i.createSetNameAction("A_" + i.name)));
  return items.length;
`;
