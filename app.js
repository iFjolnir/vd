(function(){

  var LIBRARY_INDEX_KEY = 'vocab-drill-library';
  var GLOBAL_PREFS_KEY = 'vocab-drill-prefs';
  function deckKey(id){ return 'vocab-drill-deck:' + id; }

  // ---- Universal storage adapter ----
  // Uses window.storage when running as a Claude artifact preview, otherwise the
  // browser's localStorage, behind the same promise-based interface. The two never
  // share data: moving between them needs an export/import.
  function getStorage(){
    if(window.storage) return window.storage;
    var fallback = {
      isNative: false,
      get: function(key){
        try{
          var val = localStorage.getItem(key);
          return Promise.resolve(val ? {key:key, value:val} : null);
        }catch(e){ return Promise.reject(e); }
      },
      set: function(key, value){
        try{
          localStorage.setItem(key, value);
          return Promise.resolve({key:key, value:value});
        }catch(e){ return Promise.reject(e); }
      },
      delete: function(key){
        try{
          localStorage.removeItem(key);
          return Promise.resolve({key:key, deleted:true});
        }catch(e){ return Promise.reject(e); }
      }
    };
    return fallback;
  }
  var storage = getStorage();
  storage.isNative = !!window.storage;

  var state = {
    screen: 'loading',     // loading | welcome | onboarding | library | loader | select | drill | summary | manage
    activeDeckId: null,
    libraryIndex: [],      // [{id, name, updatedAt}]
    newDeckPromptOpen: false,
    newDeckDraftFolder: null,
    newDeckDraftName: '',
    sideMenuOpen: false,
    importCollision: null,
    sideMenuContext: null, // 'deck' | 'library'
    folderEditorOpen: false,
    appName: 'Vocab Drill',
    editingAppName: false,
    welcomeNameDraft: '',
    onboardingSeen: false,
    chapters: {},
    chapterOrder: [],
    session: null,
    timerEnabled: false,
    timerSeconds: 12,
    rawInput: '',
    addMoreInput: '',
    theme: 'dark',
    deckName: '',
    editingDeckName: false,
    modeSheet: null,       // {chapterKeys, label} while picking a drill mode
    modeSheetReversed: false,
    customTestSelection: [],
    exportSelection: [],
    activeChapter: null,
    chapterEditMode: false,
    editingChapterName: false,
    chapterBulkInput: '',
    storageStatus: 'checking', // checking | ok | unavailable
    keyboardShortcutsEnabled: true,
    dismissShortcutHints: false,
    showShortcutHint: false,
    shortcutHintMode: null
  };

  function uid(){ return Math.random().toString(36).slice(2,10); }

  // Id of the deck whose content is actually in state.chapters. activeDeckId alone isn't
  // proof (the Manage Library folder editor sets it without loading the deck).
  var loadedDeckId = null;

  // ---------------- Parsing ----------------
  function parseVocabText(text, defaultChapter){
    var lines = text.split('\n');
    var chapters = {}; var order = []; var current = null;
    lines.forEach(function(line){
      var trimmed = line.trim();
      if(!trimmed) return;
      if(trimmed.includes('|')){
        if(!current){ current = defaultChapter || 'CH1'; if(order.indexOf(current)===-1){order.push(current); chapters[current]=[];} }
        var parts = trimmed.split('|');
        var term = parts[0].trim();
        var def = parts.slice(1).join('|').trim();
        if(term && def) chapters[current].push({ id: uid(), term: term, def: def, box:1, seen:0, correct:0, wrong:0, flagged:false });
      } else {
        current = trimmed;
        if(order.indexOf(current)===-1){ order.push(current); chapters[current] = []; }
      }
    });
    return { chapters: chapters, order: order };
  }

  // Merge freshly parsed vocab into existing state without touching existing progress.
  // Existing chapters get new words appended (skipping exact term+def duplicates).
  // New chapter headers get appended to chapterOrder in the order encountered.
  function mergeParsedVocab(parsed){
    var addedWords = 0, addedChapters = 0, skippedDupes = 0;
    parsed.order.forEach(function(ck){
      if(state.chapterOrder.indexOf(ck) === -1){
        state.chapterOrder.push(ck);
        state.chapters[ck] = [];
        addedChapters++;
      }
      var existing = state.chapters[ck];
      parsed.chapters[ck].forEach(function(w){
        var dupe = existing.some(function(ew){ return ew.term === w.term && ew.def === w.def; });
        if(dupe){ skippedDupes++; return; }
        existing.push(w);
        addedWords++;
      });
    });
    return { addedWords: addedWords, addedChapters: addedChapters, skippedDupes: skippedDupes };
  }

  // Reset progress (seen/correct/wrong/box/flagged) on every word of the loaded deck,
  // WITHOUT touching chapters, words, or their id/term/def.
  function resetAllProgress(){
    var wordCount = 0;
    state.chapterOrder.forEach(function(ck){
      state.chapters[ck].forEach(function(w){
        w.box = 1; w.seen = 0; w.correct = 0; w.wrong = 0; w.flagged = false;
        wordCount++;
      });
    });
    return { wordCount: wordCount };
  }

  // ---------------- In-app toast ----------------
  var toastTimeout = null;
  function showToast(message){
    state.toast = message;
    render();
    if(toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function(){ state.toast = null; render(); }, 2600);
  }
  function renderToast(){
    return el('div',{class:'toast'},[text(state.toast)]);
  }

  // ---------------- In-app confirm ----------------
  function askConfirm(message, onYes){
    state.confirmDialog = { message: message, onYes: onYes };
    render();
  }
  function renderConfirmDialog(){
    var cd = state.confirmDialog;
    // z-index 70: above the side menu (60), so confirms opened from the menu aren't buried.
    var overlay = el('div',{class:'sheet-overlay overlay-above-menu', onclick:function(e){ if(e.target === e.currentTarget){ state.confirmDialog=null; render(); } }});
    var sheet = el('div',{class:'sheet'});
    sheet.appendChild(el('h3',{},[text('Are you sure?')]));
    sheet.appendChild(el('p',{class:'sub'},[text(cd.message)]));
    sheet.appendChild(el('div',{class:'row'},[
      el('button',{class:'ghost-btn', onclick:function(){ state.confirmDialog=null; render(); }},[text('Cancel')]),
      el('button',{class:'primary-btn danger-btn', onclick:function(){
        var fn = cd.onYes; state.confirmDialog=null; fn();
      }},[text('Yes, do it')])
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }

  // Three-choice prompt for resolving one colliding deck at a time during a library
  // import, rather than the usual yes/no confirm dialog.
  function renderImportCollisionDialog(){
    var ic = state.importCollision;
    var overlay = el('div',{class:'sheet-overlay overlay-top'});
    var sheet = el('div',{class:'sheet'});
    sheet.appendChild(el('h3',{},[text('Deck already exists')]));
    sheet.appendChild(el('p',{class:'sub'},[text('A deck named "' + ic.existing.name + '" already exists in your library. What do you want to do with the incoming copy?')]));
    function choose(choice){
      var fn = ic.onChoice;
      state.importCollision = null;
      fn(choice);
    }
    sheet.appendChild(el('div',{class:'options-bar stacked'},[
      el('button',{class:'ghost-btn', onclick:function(){ choose('skip'); }},[text('Skip — keep my existing deck')]),
      el('button',{class:'ghost-btn danger-btn', onclick:function(){ choose('overwrite'); }},[text('Overwrite my existing deck')]),
      el('button',{class:'primary-btn', onclick:function(){ choose('copy'); }},[text('Import as a copy ("' + ic.deck.name + '_copy")')])
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }

  // ---- Global prefs (theme/timer) — shared across every library, never deck-specific ----
  function saveGlobalPrefs(){
    var payload = JSON.stringify({theme:state.theme, timerEnabled:state.timerEnabled, timerSeconds:state.timerSeconds, keyboardShortcutsEnabled:state.keyboardShortcutsEnabled, dismissShortcutHints:state.dismissShortcutHints, appName:state.appName, onboardingSeen:state.onboardingSeen});
    storage.set(GLOBAL_PREFS_KEY, payload).catch(function(){});
  }
  function loadGlobalPrefs(){
    return storage.get(GLOBAL_PREFS_KEY).then(function(res){
      if(res && res.value){
        try{
          var data = JSON.parse(res.value);
          if(data.theme) state.theme = data.theme;
          if(typeof data.timerEnabled === 'boolean') state.timerEnabled = data.timerEnabled;
          if(data.timerSeconds) state.timerSeconds = data.timerSeconds;
          if(typeof data.keyboardShortcutsEnabled === 'boolean') state.keyboardShortcutsEnabled = data.keyboardShortcutsEnabled;
          if(typeof data.dismissShortcutHints === 'boolean') state.dismissShortcutHints = data.dismissShortcutHints;
          if(typeof data.appName === 'string' && data.appName) state.appName = data.appName;
          if(typeof data.onboardingSeen === 'boolean') state.onboardingSeen = data.onboardingSeen;
        }catch(e){}
      }
    }).catch(function(){});
  }

  // ---- Library index — the list of decks that exist, independent of any single deck's content ----
  function saveLibraryIndex(){
    var payload = JSON.stringify({decks: state.libraryIndex});
    return storage.set(LIBRARY_INDEX_KEY, payload).catch(function(){
      // Swallowed deliberately: the in-memory index is still correct and gets
      // written again on the next save.
      return null;
    });
  }
  function loadLibraryIndex(){
    return storage.get(LIBRARY_INDEX_KEY).then(function(res){
      if(res && res.value){
        try{
          var data = JSON.parse(res.value);
          if(data.decks) state.libraryIndex = data.decks;
        }catch(e){}
      }
    }).catch(function(){});
  }
  function togglePin(id){
    var entry = state.libraryIndex.find(function(d){ return d.id === id; });
    if(entry){
      entry.pinned = !entry.pinned;
      saveLibraryIndex();
    }
    render();
  }

  function removeLibraryEntry(id){
    var idx = state.libraryIndex.findIndex(function(d){ return d.id === id; });
    if(idx !== -1) state.libraryIndex.splice(idx,1);
    saveLibraryIndex();
  }

  // ---- Per-deck content (chapters/words/progress) ----
  var libraryIndexSaveTimer = null;
  function scheduleLibraryIndexUpdate(){
    var id = state.activeDeckId;
    if(!id) return;
    var entry = state.libraryIndex.find(function(d){ return d.id === id; });
    var chapterCount = state.chapterOrder.length;
    var wordCount = 0;
    state.chapterOrder.forEach(function(ck){ wordCount += (state.chapters[ck]||[]).length; });
    var name = state.deckName || 'Untitled deck';
    if(entry){
      entry.name = name; entry.updatedAt = Date.now();
      entry.chapterCount = chapterCount; entry.wordCount = wordCount;
    } else {
      state.libraryIndex.push({id:id, name:name, updatedAt:Date.now(), chapterCount:chapterCount, wordCount:wordCount});
    }
    // Debounced: the index is only library-screen metadata, so it doesn't need a write
    // on every drill answer or compete with the per-deck content save.
    clearTimeout(libraryIndexSaveTimer);
    libraryIndexSaveTimer = setTimeout(saveLibraryIndex, 800);
  }

  var saveToStorageTimer = null;
  function saveToStorage(){
    if(!state.activeDeckId) return; // nothing loaded yet — nothing to save
    // Debounced here so rapid-fire callers (e.g. tabbing through word-edit fields)
    // trigger one full-deck save instead of one per field.
    clearTimeout(saveToStorageTimer);
    saveToStorageTimer = setTimeout(function(){
      var payload = JSON.stringify({chapters:state.chapters, chapterOrder:state.chapterOrder, deckName:state.deckName});
      storage.set(deckKey(state.activeDeckId), payload).then(function(res){
        state.storageStatus = res ? 'ok' : 'unavailable';
        if(res){
          // Clear any error left over from an earlier failed save.
          state.saveErrorDetail = null;
          state.saveErrorPayloadSize = null;
        }
        if(state.sideMenuOpen) render();
      }).catch(function(err){
        state.storageStatus = 'unavailable';
        state.saveErrorDetail = (err && (err.message || String(err))) || 'unknown error';
        state.saveErrorPayloadSize = payload.length;
        if(state.sideMenuOpen) render();
      });
    }, 350);
    scheduleLibraryIndexUpdate();
  }

  // onLoaded (optional) runs instead of the final render, whether the load succeeded or not.
  function loadDeck(id, onLoaded){
    state.activeDeckId = id;
    loadedDeckId = null;
    state.rawInput = '';
    state.loadDeckError = false;
    // Opening a deck abandons any half-filled "new deck" prompt, so it doesn't
    // reappear on return to the library.
    state.newDeckPromptOpen = false;
    state.newDeckDraftFolder = null;
    state.newDeckDraftName = '';
    storage.get(deckKey(id)).then(function(res){
      state.storageStatus = 'ok';
      state.chapters = {}; state.chapterOrder = []; state.deckName = '';
      if(res && res.value){
        try{
          var data = JSON.parse(res.value);
          if(data.chapters && data.chapterOrder){
            state.chapters = data.chapters;
            state.chapterOrder = data.chapterOrder;
            if(typeof data.deckName === 'string') state.deckName = data.deckName;
          }
        }catch(e){}
      }
      loadedDeckId = id;
      state.screen = state.chapterOrder.length ? 'select' : 'loader';
      if(onLoaded) onLoaded(); else render();
    }).catch(function(err){
      // A failed read is not an empty deck: the content may still be safe in storage.
      // Show an error screen with retry rather than the blank paste screen, which would
      // invite overwriting it.
      state.storageStatus = 'unavailable';
      state.loadDeckError = true;
      state.loadDeckErrorDetail = (err && (err.message || String(err))) || 'unknown error';
      state.screen = 'loadError';
      if(onLoaded) onLoaded(); else render();
    });
  }

  function duplicateDeck(sourceId){
    if(sourceId !== state.activeDeckId) return; // duplication always works on the currently loaded deck
    var newId = uid() + uid();
    var newChapters = {};
    state.chapterOrder.forEach(function(ck){
      newChapters[ck] = state.chapters[ck].map(function(w){
        return { id: uid(), term: w.term, def: w.def, box: w.box, seen: w.seen, correct: w.correct, wrong: w.wrong, flagged: w.flagged };
      });
    });
    var newName = (state.deckName || 'Untitled deck') + ' (copy)';
    var payload = JSON.stringify({chapters: newChapters, chapterOrder: state.chapterOrder.slice(), deckName: newName});
    storage.set(deckKey(newId), payload);
    var chapterCount = state.chapterOrder.length;
    var wordCount = 0;
    state.chapterOrder.forEach(function(ck){ wordCount += newChapters[ck].length; });
    state.libraryIndex.push({id:newId, name:newName, updatedAt:Date.now(), chapterCount:chapterCount, wordCount:wordCount, pinned:false});
    saveLibraryIndex();
    showToast('Duplicated as "' + newName + '"');
    render();
  }

  function createNewDeck(name){
    var id = uid() + uid();
    state.activeDeckId = id;
    loadedDeckId = id;
    state.chapters = {}; state.chapterOrder = []; state.deckName = name || ''; state.rawInput = '';
    state.screen = 'loader';
    var chapterCount = 0, wordCount = 0;
    var cfg = state.newDeckDraftFolder || randomFolderConfig();
    state.libraryIndex.push({
      id:id, name: state.deckName || 'Untitled deck', updatedAt: Date.now(),
      chapterCount: chapterCount, wordCount: wordCount,
      folderShape: cfg.folderShape, folderStyle: cfg.folderStyle, folderHue: cfg.folderHue
    });
    saveLibraryIndex();
    state.newDeckDraftFolder = null;
    saveToStorage();
    render();
  }

  function deleteDeckEntirely(id){
    removeLibraryEntry(id);
    storage.delete(deckKey(id)).catch(function(){});
    if(loadedDeckId === id) loadedDeckId = null;
    if(state.activeDeckId === id){
      state.activeDeckId = null;
      state.chapters = {}; state.chapterOrder = []; state.deckName = '';
    }
  }

  function goToLibrary(){
    state.activeDeckId = null;
    state.screen = 'library';
    render();
  }

  function wipeEverything(){
    var ids = state.libraryIndex.map(function(d){ return d.id; });
    ids.forEach(function(id){
      storage.delete(deckKey(id)).catch(function(){});
    });
    storage.delete(LIBRARY_INDEX_KEY).catch(function(){});
    storage.delete(GLOBAL_PREFS_KEY).catch(function(){});
    state.libraryIndex = [];
    state.activeDeckId = null;
    loadedDeckId = null;
    state.chapters = {}; state.chapterOrder = []; state.deckName = '';
    state.theme = 'dark';
    state.timerEnabled = false; state.timerSeconds = 12;
    state.keyboardShortcutsEnabled = true; state.dismissShortcutHints = false;
    state.appName = 'Vocab Drill';
    state.onboardingSeen = false;
    state.welcomeNameDraft = '';
    applyTheme();
    applyAppName();
    state.screen = 'welcome';
    render();
  }

  function bootApp(){
    loadGlobalPrefs().then(function(){
      applyTheme();
      applyAppName();
      return loadLibraryIndex();
    }).then(function(){
      initNav();
      if(!state.onboardingSeen && state.libraryIndex.length === 0){
        state.welcomeNameDraft = '';
        state.screen = 'welcome';
        nav.replaceNext = true;
        render();
      } else {
        // Open whatever screen the address points at (a refresh or a shared link).
        applyRoute(location.hash);
      }
    });
  }

  function exportState(){
    var data = JSON.stringify({kind:'backup', chapters:state.chapters, chapterOrder:state.chapterOrder, deckName:state.deckName});
    var blob = new Blob([data], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = (state.deckName || 'vocab').replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-') + '-progress-backup.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Whole-library export: reads every deck from storage (only the open deck is in
  // state.chapters) and bundles them into one JSON file.
  function exportWholeLibrary(){
    var deckIds = state.libraryIndex.map(function(d){ return d.id; });
    var reads = deckIds.map(function(id){
      return storage.get(deckKey(id)).then(function(res){
        var content = null;
        if(res && res.value){ try{ content = JSON.parse(res.value); }catch(e){} }
        var indexEntry = state.libraryIndex.find(function(d){ return d.id === id; });
        return {
          id: id,
          name: (content && content.deckName) || (indexEntry && indexEntry.name) || 'Untitled deck',
          chapters: content ? content.chapters : {},
          chapterOrder: content ? content.chapterOrder : [],
          folderShape: indexEntry ? indexEntry.folderShape : 'x',
          folderStyle: indexEntry ? indexEntry.folderStyle : 'bright',
          folderHue: indexEntry ? indexEntry.folderHue : 0,
          pinned: indexEntry ? !!indexEntry.pinned : false
        };
      });
    });
    Promise.all(reads).then(function(decks){
      var data = JSON.stringify({kind:'library-backup', decks: decks});
      var blob = new Blob([data], {type:'application/json'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = (state.appName || 'vocab-drill').replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-') + '-library-backup.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Exported ' + decks.length + ' deck' + (decks.length===1?'':'s') + '~');
    });
  }

  // Build a shareable export: only term/def content for the chosen chapters, with every
  // progress field reset to defaults. Recipients get a clean, unstudied copy of the words —
  // never someone else's study history.
  function exportShareableSet(chapterKeys){
    var chapters = {};
    chapterKeys.forEach(function(ck){
      chapters[ck] = state.chapters[ck].map(function(w){
        return { id: uid(), term: w.term, def: w.def, box:1, seen:0, correct:0, wrong:0, flagged:false };
      });
    });
    var data = JSON.stringify({kind:'shareable', chapters:chapters, chapterOrder:chapterKeys.slice()});
    var blob = new Blob([data], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var namePart = chapterKeys.length === 1 ? chapterKeys[0] : (state.deckName || 'vocab-set');
    a.href = url; a.download = namePart.replace(/[^a-z0-9\-_ ]/gi,'').trim().replace(/\s+/g,'-') + '-shareable.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function importStateFile(file){
    var reader = new FileReader();
    reader.onload = function(e){
      try{
        var data = JSON.parse(e.target.result);
        if(data.kind === 'library-backup'){
          importWholeLibrary(data);
          return;
        }
        if(!data.chapters || !data.chapterOrder){ throw new Error('bad shape'); }

        if(data.kind === 'shareable'){
          // Shareable sets merge into whatever's currently loaded, same as "Add more vocab" —
          // never wipe the importer's own deck just because they loaded someone else's set.
          var parsed = { chapters: data.chapters, order: data.chapterOrder };
          var result = mergeParsedVocab(parsed);
          state.screen = 'select';
          saveToStorage();
          render();
          var msg = 'Imported ' + result.addedWords + ' word' + (result.addedWords===1?'':'s');
          if(result.addedChapters) msg += ' across ' + result.addedChapters + ' new chapter' + (result.addedChapters===1?'':'s');
          if(result.skippedDupes) msg += ' (' + result.skippedDupes + ' duplicate' + (result.skippedDupes===1?'':'s') + ' skipped)';
          showToast(msg);
        } else {
          // Backup (or untagged legacy export): a full personal-progress restore, so it
          // replaces the currently loaded deck rather than merging into it.
          askConfirm('Import this backup? It will replace everything currently loaded — export first if you want to keep it.', function(){
            state.chapters = data.chapters;
            state.chapterOrder = data.chapterOrder;
            if(typeof data.deckName === 'string') state.deckName = data.deckName;
            state.screen = 'select';
            saveToStorage();
            render();
            showToast('Backup restored');
          });
        }
      }catch(err){ showToast('Could not read that file — is it a vocab export?'); }
    };
    reader.readAsText(file);
  }

  // Whole-library import: decks with new IDs import straight away; each ID collision
  // gets its own skip / overwrite / copy prompt.
  function importWholeLibrary(data){
    if(!data.decks || !Array.isArray(data.decks)){ showToast('Could not read that file — is it a library backup?'); return; }
    var queue = data.decks.slice();
    var importedCount = 0;

    function processNext(){
      if(queue.length === 0){
        showToast('Imported ' + importedCount + ' deck' + (importedCount===1?'':'s') + '~');
        render();
        return;
      }
      var deck = queue.shift();
      var existing = state.libraryIndex.find(function(d){ return d.id === deck.id; });
      if(!existing){
        writeImportedDeck(deck, deck.id);
        importedCount++;
        processNext();
      } else {
        renderImportCollisionPrompt(deck, existing, function(choice){
          if(choice === 'skip'){
            // do nothing
          } else if(choice === 'overwrite'){
            writeImportedDeck(deck, deck.id);
            importedCount++;
          } else if(choice === 'copy'){
            var newId = uid() + uid();
            var copyName = deck.name + '_copy';
            writeImportedDeck(Object.assign({}, deck, {name: copyName}), newId);
            importedCount++;
          }
          processNext();
        });
      }
    }
    processNext();
  }

  function writeImportedDeck(deck, id){
    var payload = JSON.stringify({chapters: deck.chapters, chapterOrder: deck.chapterOrder, deckName: deck.name});
    storage.set(deckKey(id), payload);
    var existingIdx = state.libraryIndex.findIndex(function(d){ return d.id === id; });
    var entry = {
      id: id, name: deck.name, updatedAt: Date.now(),
      chapterCount: (deck.chapterOrder||[]).length,
      wordCount: (deck.chapterOrder||[]).reduce(function(sum, ck){ return sum + ((deck.chapters[ck]||[]).length); }, 0),
      folderShape: deck.folderShape || 'x', folderStyle: deck.folderStyle || 'bright', folderHue: deck.folderHue || 0,
      pinned: !!deck.pinned
    };
    if(existingIdx !== -1) state.libraryIndex[existingIdx] = entry;
    else state.libraryIndex.push(entry);
    saveLibraryIndex();
  }

  // Opens the three-choice collision dialog (renderImportCollisionDialog) for one deck.
  function renderImportCollisionPrompt(deck, existing, onChoice){
    state.importCollision = { deck: deck, existing: existing, onChoice: onChoice };
    render();
  }

  // ---------------- Theme ----------------
  function applyTheme(){
    document.documentElement.setAttribute('data-theme', state.theme);
    // Matches the browser/status bar colour to the theme's background (--bg).
    var meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute('content', state.theme === 'light' ? '#F7F4EE' : '#1C1B1F');
  }
  function applyAppName(){
    document.title = state.appName || 'Vocab Drill';
  }
  function toggleTheme(){
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveGlobalPrefs();
    render();
  }

  // ---------------- Session logic (shared) ----------------
  function buildPool(chapterKeys, filterMode){
    var pool = [];
    chapterKeys.forEach(function(ck){
      state.chapters[ck].forEach(function(w){ pool.push({ref:w, chKey:ck}); });
    });
    if(filterMode === 'flagged'){
      pool = pool.filter(function(item){ return item.ref.flagged || item.ref.wrong > item.ref.correct; });
    }
    shuffleArr(pool);
    return pool;
  }
  // Direction-aware display helpers: pick which field shows as "prompt" vs "answer"
  // for this session. The word object itself is never copied or changed.
  function promptText(w){ return state.session && state.session.reversed ? w.def : w.term; }
  function answerText(w){ return state.session && state.session.reversed ? w.term : w.def; }
  // Styling follows the field, not the role: term always gets the big Korean-font
  // style, def the smaller plain style, whichever direction the session runs.
  function promptClass(){ return state.session && state.session.reversed ? 'word-def' : 'word-term kr'; }
  function answerClass(){ return state.session && state.session.reversed ? 'word-term kr' : 'word-def'; }
  function shuffleArr(arr){
    for(var i=arr.length-1;i>0;i--){
      var j = Math.floor(Math.random()*(i+1));
      var tmp = arr[i]; arr[i]=arr[j]; arr[j]=tmp;
    }
    return arr;
  }

  function startFlipSession(chapterKeys, filterMode, reversed){
    var pool = buildPool(chapterKeys, filterMode);
    if(pool.length === 0){ showToast('No words match this mode yet — flag some or get some wrong first!'); return; }
    state.session = {
      type:'flip', chapterKeys: chapterKeys, mode: filterMode, reversed: !!reversed,
      queue: pool, index: 0, flipped: false,
      correctCount: 0, wrongCount: 0, missed: [],
      timeLeft: state.timerSeconds, timerHandle: null
    };
    state.screen = 'drill';
    maybeShowShortcutHint('flip');
    render();
    if(state.timerEnabled) startTimer();
  }

  function startMCSession(chapterKeys, filterMode, reversed){
    var pool = buildPool(chapterKeys, filterMode);
    if(pool.length === 0){ showToast('No words match this mode yet — flag some or get some wrong first!'); return; }
    state.session = {
      type:'mc', chapterKeys: chapterKeys, mode: filterMode, reversed: !!reversed,
      queue: pool, index: 0,
      correctCount: 0, wrongCount: 0, missed: [],
      answered: false, chosenIdx: null, options: null,
      timeLeft: state.timerSeconds, timerHandle: null
    };
    buildMCOptions();
    state.screen = 'drill';
    maybeShowShortcutHint('mc');
    render();
    if(state.timerEnabled) startTimer();
  }

  var shortcutHintShownFor = {};
  function maybeShowShortcutHint(mode){
    if(!state.keyboardShortcutsEnabled) return;
    if(state.dismissShortcutHints) return;
    if(shortcutHintShownFor[mode]) return;
    shortcutHintShownFor[mode] = true;
    state.shortcutHintMode = mode;
    state.showShortcutHint = true;
  }

  function buildMCOptions(){
    var s = state.session;
    var current = s.queue[s.index];
    var chapterWords = state.chapters[current.chKey];
    var distractorPool = chapterWords.filter(function(w){ return w.id !== current.ref.id; });
    shuffleArr(distractorPool);
    var distractors = distractorPool.slice(0, 3);
    // pad from full deck if chapter too small
    if(distractors.length < 3){
      var need = 3 - distractors.length;
      var fullPool = [];
      state.chapterOrder.forEach(function(ck){
        state.chapters[ck].forEach(function(w){
          if(w.id !== current.ref.id && distractors.indexOf(w)===-1) fullPool.push(w);
        });
      });
      shuffleArr(fullPool);
      distractors = distractors.concat(fullPool.slice(0, need));
    }
    var options = distractors.map(function(w){ return {text:answerText(w), correct:false}; });
    options.push({text: answerText(current.ref), correct:true});
    shuffleArr(options);
    s.options = options;
    s.answered = false;
    s.chosenIdx = null;
  }

  // Splits a pool into match-mode rounds of 6. A leftover of 1-2 words is merged into
  // the previous round (allowing 7 or 8) rather than shown as a tiny final round,
  // e.g. 20 words -> 6/6/8, 9 words -> 6/3.
  function computeMatchRoundSizes(total){
    var MAX = 6, MIN = 3;
    if(total <= MAX) return [total];
    var rounds = [];
    var remaining = total;
    while(remaining > MAX){
      rounds.push(MAX);
      remaining -= MAX;
    }
    if(remaining >= MIN){
      rounds.push(remaining);
    } else if(rounds.length > 0){
      rounds[rounds.length-1] += remaining;
    } else {
      rounds.push(remaining);
    }
    return rounds;
  }

  function startMatchSession(chapterKeys, filterMode, reversed){
    var pool = buildPool(chapterKeys, filterMode);
    if(pool.length === 0){ showToast('No words match this mode yet — flag some or get some wrong first!'); return; }
    state.session = {
      type:'match', chapterKeys: chapterKeys, mode: filterMode, reversed: !!reversed,
      fullQueue: pool, roundIndex: 0, roundSizes: computeMatchRoundSizes(pool.length), roundNum: 0,
      correctCount: 0, wrongCount: 0, missed: [],
      termTiles: [], defTiles: [], selectedTerm: null, selectedDef: null, lockedIds: []
    };
    setupMatchRound();
    state.screen = 'drill';
    render();
  }

  function setupMatchRound(){
    var s = state.session;
    var start = s.roundIndex;
    var thisRoundSize = s.roundSizes[s.roundNum];
    var slice = s.fullQueue.slice(start, start + thisRoundSize);
    s.currentRound = slice;
    s.termTiles = shuffleArr(slice.map(function(item){ return {id:item.ref.id, text:promptText(item.ref), ref:item.ref, chKey:item.chKey}; }));
    s.defTiles = shuffleArr(slice.map(function(item){ return {id:item.ref.id, text:answerText(item.ref), ref:item.ref}; }));
    s.selectedTerm = null; s.selectedDef = null; s.lockedIds = [];
  }

  function startTimer(){
    clearTimer();
    state.session.timeLeft = state.timerSeconds;
    state.session.timerHandle = setInterval(function(){
      if(!state.session){ clearTimer(); return; }
      state.session.timeLeft -= 1;
      if(state.session.timeLeft <= 0){
        clearTimer();
        if(state.session.type === 'flip'){
          if(!state.session.flipped){ state.session.flipped = true; render(); setTimeout(function(){ markFlip(false); }, 700); return; }
        } else if(state.session.type === 'mc'){
          if(!state.session.answered){ chooseMC(-1); return; }
        }
      }
      renderTimerOnly();
    }, 1000);
  }
  function clearTimer(){
    if(state.session && state.session.timerHandle){ clearInterval(state.session.timerHandle); state.session.timerHandle = null; }
  }

  // ---- flip mode actions ----
  function flipCard(){ if(!state.session) return; state.session.flipped = !state.session.flipped; render(); }

  // Swipe gestures for flip mode: swipe right = Got it, swipe left = Missed it. One swipe
  // both reveals and judges the card; a plain tap still just flips it. Only a clearly
  // horizontal gesture counts as a swipe, so vertical scrolling keeps working.
  function attachSwipeHandlers(shellEl, cardEl){
    var SWIPE_THRESHOLD = 80;
    var TAP_THRESHOLD = 10;
    var HORIZONTAL_INTENT_RATIO = 1.5; // how much more horizontal than vertical movement must be before we treat it as a swipe, not a scroll
    var touchState = null;

    shellEl.addEventListener('touchstart', function(e){
      if(e.touches.length !== 1) return;
      touchState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, dragging: false, committedHorizontal: false };
    }, {passive: true});

    shellEl.addEventListener('touchmove', function(e){
      if(!touchState || e.touches.length !== 1) return;
      var dx = e.touches[0].clientX - touchState.startX;
      var dy = e.touches[0].clientY - touchState.startY;
      if(!touchState.committedHorizontal){
        if(Math.abs(dx) < TAP_THRESHOLD && Math.abs(dy) < TAP_THRESHOLD) return;
        // Decide once, early, whether this gesture is horizontal (swipe) or vertical
        // (scroll) -- and stick with that decision for the rest of the gesture.
        touchState.committedHorizontal = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_INTENT_RATIO;
        if(!touchState.committedHorizontal) return; // let the page scroll normally
      }
      touchState.dragging = true;
      touchState.dx = dx;
      e.preventDefault();
      cardEl.style.transition = 'none';
      cardEl.style.transform = 'translateX(' + dx + 'px) rotate(' + (dx/20) + 'deg)';
      cardEl.classList.toggle('swipe-good', dx > SWIPE_THRESHOLD*0.4);
      cardEl.classList.toggle('swipe-bad', dx < -SWIPE_THRESHOLD*0.4);
    }, {passive: false});

    shellEl.addEventListener('touchend', function(e){
      if(!touchState) return;
      var wasDragging = touchState.dragging;
      var dx = touchState.dx || 0;
      cardEl.style.transition = '';
      cardEl.style.transform = '';
      cardEl.classList.remove('swipe-good', 'swipe-bad');
      if(wasDragging && Math.abs(dx) >= SWIPE_THRESHOLD){
        e.preventDefault(); // stop the synthetic click that would otherwise follow
        var s = state.session;
        if(s){
          if(!s.flipped) s.flipped = true;
          markFlip(dx > 0);
        }
      } else if(wasDragging){
        // Dragged but not far enough: snap back, and suppress the click.
        e.preventDefault();
      }
      // A plain tap falls through to the browser's click, which the card's
      // onclick=flipCard handles.
      touchState = null;
    });

    shellEl.addEventListener('touchcancel', function(){
      cardEl.style.transition = '';
      cardEl.style.transform = '';
      cardEl.classList.remove('swipe-good', 'swipe-bad');
      touchState = null;
    });
  }

  function markFlip(gotIt){
    var s = state.session; if(!s) return;
    var current = s.queue[s.index]; var w = current.ref;
    recordResult(w, gotIt, s);
    clearTimer();
    if(s.index + 1 >= s.queue.length){ finishSession(); }
    else { s.index += 1; s.flipped = false; render(); if(state.timerEnabled) startTimer(); }
  }

  // ---- MC mode actions ----
  function chooseMC(idx){
    var s = state.session; if(!s || s.answered) return;
    clearTimer();
    s.answered = true; s.chosenIdx = idx;
    var current = s.queue[s.index]; var w = current.ref;
    var gotIt = idx >= 0 && s.options[idx].correct;
    recordResult(w, gotIt, s);
    render();
    setTimeout(function(){
      if(s.index + 1 >= s.queue.length){ finishSession(); }
      else { s.index += 1; buildMCOptions(); render(); if(state.timerEnabled) startTimer(); }
    }, 900);
  }

  // ---- Keyboard shortcuts for drilling ----
  // Flip mode: Space flips the card, Enter marks "Got it", Shift marks "Missed it" (only once flipped).
  // MC mode: 1-4 picks the corresponding option.
  // Only active during an actual drill, and only if the person hasn't turned it off in Settings.
  // Typing into an input/textarea anywhere else in the app is never intercepted.
  function handleDrillKeydown(e){
    if(!state.keyboardShortcutsEnabled) return;
    if(state.screen !== 'drill' || !state.session) return;
    var tag = (e.target && e.target.tagName) || '';
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Release focus from any button (e.g. after clicking "Got it"), so the browser's own
    // Enter/Space button activation doesn't fire on top of ours.
    if(document.activeElement && document.activeElement.tagName === 'BUTTON'){
      document.activeElement.blur();
    }

    var s = state.session;
    if(s.type === 'flip'){
      if(e.code === 'Space'){
        e.preventDefault();
        flipCard();
      } else if(e.key === 'Enter'){
        e.preventDefault();
        if(!s.flipped){ flipCard(); } else { markFlip(true); }
      } else if(e.key === 'Shift'){
        e.preventDefault();
        if(!s.flipped){ flipCard(); } else { markFlip(false); }
      }
    } else if(s.type === 'mc'){
      if(['1','2','3','4'].indexOf(e.key) !== -1 && !s.answered){
        var idx = parseInt(e.key,10) - 1;
        if(s.options && idx < s.options.length){ e.preventDefault(); chooseMC(idx); }
      }
    }
  }
  document.addEventListener('keydown', handleDrillKeydown);

  // ---- Match mode actions ----
  function selectMatchTile(side, tile){
    var s = state.session; if(!s) return;
    if(s.lockedIds.indexOf(tile.id) !== -1) return;
    if(side === 'term') s.selectedTerm = (s.selectedTerm && s.selectedTerm.id===tile.id) ? null : tile;
    else s.selectedDef = (s.selectedDef && s.selectedDef.id===tile.id) ? null : tile;

    if(s.selectedTerm && s.selectedDef){
      var isMatch = s.selectedTerm.id === s.selectedDef.id;
      if(isMatch){
        var w = s.selectedTerm.ref;
        recordResult(w, true, s);
        s.lockedIds.push(w.id);
        s.selectedTerm = null; s.selectedDef = null;
        render();
        // check round/session complete
        if(s.lockedIds.length >= s.currentRound.length){
          setTimeout(function(){
            s.roundIndex += s.roundSizes[s.roundNum];
            s.roundNum += 1;
            if(s.roundNum >= s.roundSizes.length){ finishSession(); }
            else { setupMatchRound(); render(); }
          }, 450);
        }
      } else {
        var wrongTerm = s.selectedTerm.ref, wrongDef = s.selectedDef.ref;
        // count as a wrong attempt on the term word only (avoid double punishing)
        recordResult(wrongTerm, false, s, true);
        var badTerm = s.selectedTerm, badDef = s.selectedDef;
        markShake(badTerm.id, 'term'); markShake(badDef.id, 'def');
        render();
        setTimeout(function(){
          if(s.selectedTerm === badTerm) s.selectedTerm = null;
          if(s.selectedDef === badDef) s.selectedDef = null;
          render();
        }, 400);
      }
    } else {
      render();
    }
  }
  var shakeIds = {};
  function markShake(id, side){ shakeIds[side+id] = true; setTimeout(function(){ delete shakeIds[side+id]; }, 400); }

  function recordResult(w, gotIt, s, isMatchMiss){
    w.seen += 1;
    if(gotIt){ w.correct += 1; w.box = Math.min(w.box+1,5); s.correctCount += 1; }
    else {
      w.wrong += 1; w.box = 1; s.wrongCount += 1;
      if(!isMatchMiss || s.missed.filter(function(m){return m.term===promptText(w);}).length === 0){
        s.missed.push({term:promptText(w), def:answerText(w)});
      }
    }
  }

  function finishSession(){
    clearTimer();
    state.screen = 'summary';
    saveToStorage();
    render();
  }

  function toggleFlag(word){ word.flagged = !word.flagged; saveToStorage(); render(); }

  function endSessionEarly(){
    clearTimer();
    saveToStorage();
    state.session = null;
    state.screen = 'select';
    render();
  }

  // ---------------- Stats helpers ----------------
  function chapterAccuracy(ck){
    var words = state.chapters[ck];
    var seen = words.filter(function(w){return w.seen>0;});
    if(seen.length===0) return null;
    var totalCorrect = seen.reduce(function(a,w){return a+w.correct;},0);
    var totalSeen = seen.reduce(function(a,w){return a+w.seen;},0);
    return Math.round((totalCorrect/totalSeen)*100);
  }
  function chapterFlaggedCount(ck){ return state.chapters[ck].filter(function(w){ return w.flagged || w.wrong > w.correct; }).length; }
  function totalWordCount(){ var n=0; state.chapterOrder.forEach(function(ck){ n += state.chapters[ck].length; }); return n; }
  function totalFlagged(){ var n=0; state.chapterOrder.forEach(function(ck){ n += chapterFlaggedCount(ck); }); return n; }

  // ---------------- DOM helpers ----------------
  var app = document.getElementById('app');
  function el(tag, attrs, children){
    var e = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function(k){
      if(k === 'class') e.className = attrs[k];
      else if(k === 'html') e.innerHTML = attrs[k];
      else if(k.indexOf('on')===0) e.addEventListener(k.slice(2), attrs[k]);
      else if(typeof attrs[k] === 'boolean'){ if(attrs[k]) e.setAttribute(k, ''); }
      else e.setAttribute(k, attrs[k]);
    });
    (children||[]).forEach(function(c){ if(c) e.appendChild(c); });
    return e;
  }
  function text(str){ return document.createTextNode(str); }
  function bookmarkSvg(){
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 22 30');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('class', 'ribbon-fill');
    path.setAttribute('d', 'M2 2 H20 V28 L11 21 L2 28 Z');
    svg.appendChild(path);
    return svg;
  }

  // ---- Icon system: Material Symbols (outlined), inlined as raw path data. ----
  // All icons share the same viewBox, so one universal render function covers every one.
  // Icons inherit color via currentColor, so button/theme styling controls their color for free.
  var ICONS = {
    arrow_back: "m313-440 224 224-57 56-320-320 320-320 57 56-224 224h487v80H313Z",
    arrow_forward: "M647-440H160v-80h487L423-744l57-56 320 320-320 320-57-56 224-224Z",
    auto_stories: "M480-160q-48-38-104-59t-116-21q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740v484q51-32 107-48t113-16q36 0 70.5 6t69.5 18v-480q15 5 29.5 10.5T898-752q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59Zm80-200v-380l200-200v400L560-360Zm-160 65v-396q-33-14-68.5-21.5T260-720q-37 0-72 7t-68 21v397q35-13 69.5-19t70.5-6q36 0 70.5 6t69.5 19Zm0 0v-396 396Z",
    bookmark: "M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Zm80-122 200-86 200 86v-518H280v518Zm0-518h400-400Z",
    bomb: "M346-48q-125 0-212.5-88.5T46-350q0-125 86.5-211.5T344-648h13l27-47q12-22 36-28.5t46 6.5l30 17 5-8q23-43 72-56t92 12l35 20-40 69-35-20q-14-8-30.5-3.5T570-668l-5 8 40 23q21 12 27.5 36t-5.5 45l-27 48q23 36 34.5 76.5T646-348q0 125-87.5 212.5T346-48Zm0-80q91 0 155.5-64.5T566-348q0-31-8.5-61T532-466l-26-41 42-72-104-60-42 72h-44q-94 0-163.5 60T125-350q0 92 64.5 157T346-128Zm454-480v-80h120v80H800ZM580-828v-120h80v120h-80Zm195 81-56-56 85-85 56 56-85 85ZM346-348Z",
    cancel: "m336-280 144-144 144 144 56-56-144-144 144-144-56-56-144 144-144-144-56 56 144 144-144 144 56 56ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
    cards_stack: "M130-189 81-546q-5-32 15.5-58t52.5-31l61 435 283-40h267q-8 21-24.5 35.5T695-187l-477 66q-33 5-58-15t-30-53Zm190-127q-33 0-56.5-23.5T240-396v-364q0-33 23.5-56.5T320-840h480q33 0 56.5 23.5T880-760v364q0 33-23.5 56.5T800-316H320Zm0-80h480v-364H320v364Zm0 0v-364 364ZM210-200Zm190-400h320v-80H400v80Zm0 120h200v-80H400v80Z",
    chat_dashed: "M80-480v-160h80v160H80Zm0 400v-320h80v125l46-45h114v80h-80L80-80Zm320-160v-80h160v80H400Zm240 0v-80h160v-80h80v80q0 33-23.5 56.5T800-240H640Zm160-240v-160h80v160h-80Zm0-239v-81H640v-80h160q33 0 56.5 23.5T880-800v81h-80Zm-400-81v-80h160v80H400ZM80-719v-81q0-33 23.5-56.5T160-880h160v80H160v81H80Z",
    check_circle: "m424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
    collections_bookmark: "M320-320h480v-480h-80v280l-100-60-100 60v-280H320v480Zm0 80q-33 0-56.5-23.5T240-320v-480q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H320ZM160-80q-33 0-56.5-23.5T80-160v-560h80v560h560v80H160Zm360-720h200-200Zm-200 0h480-480Z",
    dark_mode: "M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 27.5 1t26.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 13 3 26.5t1 27.5q0 150-105 255T480-120Zm0-80q88 0 158-48.5T740-375q-20 5-40 8t-40 3q-123 0-209.5-86.5T364-660q0-20 3-40t8-40q-78 32-126.5 102T200-480q0 116 82 198t198 82Zm-10-270Z",
    delete: "M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z",
    done_all: "M268-240 42-466l57-56 170 170 56 56-57 56Zm226 0L268-466l56-57 170 170 368-368 56 57-424 424Zm0-226-57-56 198-198 57 56-198 198Z",
    download: "M480-320 280-520l56-58 104 104v-326h80v326l104-104 56 58-200 200ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z",
    edit_square: "M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h357l-80 80H200v560h560v-278l80-80v358q0 33-23.5 56.5T760-120H200Zm280-360ZM360-360v-170l367-367q12-12 27-18t30-6q16 0 30.5 6t26.5 18l56 57q11 12 17 26.5t6 29.5q0 15-5.5 29.5T897-728L530-360H360Zm481-424-56-56 56 56ZM440-440h56l232-232-28-28-29-28-231 231v57Zm260-260-29-28 29 28 28 28-28-28Z",
    flag: "M200-120v-680h360l16 80h224v400H520l-16-80H280v280h-80Zm300-440Zm86 160h134v-240H510l-16-80H280v240h290l16 80Z",
    folder_copy: "M120-120q-33 0-56.5-23.5T40-200v-520h80v520h680v80H120Zm160-160q-33 0-56.5-23.5T200-360v-440q0-33 23.5-56.5T280-880h200l80 80h280q33 0 56.5 23.5T920-720v360q0 33-23.5 56.5T840-280H280Zm0-80h560v-360H527l-80-80H280v440Zm0 0v-440 440Z",
    history: "M480-120q-138 0-240.5-91.5T122-440h82q14 104 92.5 172T480-200q117 0 198.5-81.5T760-480q0-117-81.5-198.5T480-760q-69 0-129 32t-101 88h110v80H120v-240h80v94q51-64 124.5-99T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-120Zm112-192L440-464v-216h80v184l128 128-56 56Z",
    info: "M440-280h80v-240h-80v240Zm40-320q17 0 28.5-11.5T520-640q0-17-11.5-28.5T480-680q-17 0-28.5 11.5T440-640q0 17 11.5 28.5T480-600Zm0 520q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
    join_right: "M640-200q-27 0-52.5-5T538-219q58-49 90-117t32-144q0-76-32-144t-90-117q24-9 49.5-14t52.5-5q117 0 198.5 81.5T920-480q0 117-81.5 198.5T640-200Zm-320 0q-117 0-198.5-81.5T40-480q0-117 81.5-198.5T320-760q27 0 52.5 5t49.5 14q-17 14-32 30.5T362-676q-10-2-20.5-3t-21.5-1q-83 0-141.5 58.5T120-480q0 83 58.5 141.5T320-280q11 0 21.5-1t20.5-3q13 18 28 34.5t32 30.5q-24 9-49.5 14t-52.5 5Zm160-50q-57-39-88.5-100T360-480q0-69 31.5-130T480-710q57 39 88.5 100T600-480q0 69-31.5 130T480-250Z",
    favorite: "m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Zm0-108q96-86 158-147.5t98-107q36-45.5 50-81t14-70.5q0-60-40-100t-100-40q-47 0-87 26.5T518-680h-76q-15-41-55-67.5T300-774q-60 0-100 40t-40 100q0 35 14 70.5t50 81q36 45.5 98 107T480-228Zm0-273Z",
    favorite_fill: "m480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z",
    keep: "m640-480 80 80v80H520v240l-40 40-40-40v-240H240v-80l80-80v-280h-40v-80h400v80h-40v280Zm-286 80h252l-46-46v-314H400v314l-46 46Zm126 0Z",
    keyboard_arrow_down: "M480-344 240-584l56-56 184 184 184-184 56 56-240 240Z",
    keyboard_arrow_up: "M480-528 296-344l-56-56 240-240 240 240-56 56-184-184Z",
    keyboard_command_key: "M260-120q-58 0-99-41t-41-99q0-58 41-99t99-41h60v-160h-60q-58 0-99-41t-41-99q0-58 41-99t99-41q58 0 99 41t41 99v60h160v-60q0-58 41-99t99-41q58 0 99 41t41 99q0 58-41 99t-99 41h-60v160h60q58 0 99 41t41 99q0 58-41 99t-99 41q-58 0-99-41t-41-99v-60H400v60q0 58-41 99t-99 41Zm0-80q25 0 42.5-17.5T320-260v-60h-60q-25 0-42.5 17.5T200-260q0 25 17.5 42.5T260-200Zm440 0q25 0 42.5-17.5T760-260q0-25-17.5-42.5T700-320h-60v60q0 25 17.5 42.5T700-200ZM400-400h160v-160H400v160ZM260-640h60v-60q0-25-17.5-42.5T260-760q-25 0-42.5 17.5T200-700q0 25 17.5 42.5T260-640Zm380 0h60q25 0 42.5-17.5T760-700q0-25-17.5-42.5T700-760q-25 0-42.5 17.5T640-700v60Z",
    dataset: "M280-280h160v-160H280v160Zm240 0h160v-160H520v160ZM280-520h160v-160H280v160Zm240 0h160v-160H520v160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z",
    library_books: "M400-400h160v-80H400v80Zm0-120h320v-80H400v80Zm0-120h320v-80H400v80Zm-80 400q-33 0-56.5-23.5T240-320v-480q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H320Zm0-80h480v-480H320v480ZM160-80q-33 0-56.5-23.5T80-160v-560h80v560h560v80H160Zm160-720v480-480Z",
    light_mode: "M480-360q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Zm0 80q-83 0-141.5-58.5T280-480q0-83 58.5-141.5T480-680q83 0 141.5 58.5T680-480q0 83-58.5 141.5T480-280ZM200-440H40v-80h160v80Zm720 0H760v-80h160v80ZM440-760v-160h80v160h-80Zm0 720v-160h80v160h-80ZM256-650l-101-97 57-59 96 100-52 56Zm492 496-97-101 53-55 101 97-57 59Zm-98-550 97-101 59 57-100 96-56-52ZM154-212l101-97 55 53-97 101-59-57Zm326-268Z",
    list_alt: "M320-280q17 0 28.5-11.5T360-320q0-17-11.5-28.5T320-360q-17 0-28.5 11.5T280-320q0 17 11.5 28.5T320-280Zm0-160q17 0 28.5-11.5T360-480q0-17-11.5-28.5T320-520q-17 0-28.5 11.5T280-480q0 17 11.5 28.5T320-440Zm0-160q17 0 28.5-11.5T360-640q0-17-11.5-28.5T320-680q-17 0-28.5 11.5T280-640q0 17 11.5 28.5T320-600Zm120 320h240v-80H440v80Zm0-160h240v-80H440v80Zm0-160h240v-80H440v80ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z",
    play_lesson: "M452-160q6 20 16.5 41.5T490-80H200q-33 0-56.5-23.5T120-160v-640q0-33 23.5-56.5T200-880h480q33 0 56.5 23.5T760-800v284q-18-2-40-2t-40 2v-284H480v280l-100-60-100 60v-280h-80v640h252ZM720-40q-83 0-141.5-58.5T520-240q0-83 58.5-141.5T720-440q83 0 141.5 58.5T920-240q0 83-58.5 141.5T720-40Zm-50-100 160-100-160-100v200ZM280-800h200-200Zm172 0H200h480-240 12Z",
    menu: "M120-240v-80h720v80H120Zm0-200v-80h720v80H120Zm0-200v-80h720v80H120Z",
    settings: "m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z",
    star_shine: "M852-212 732-332l56-56 120 120-56 56ZM708-692l-56-56 120-120 56 56-120 120Zm-456 0L132-812l56-56 120 120-56 56ZM108-212l-56-56 120-120 56 56-120 120Zm246-75 126-76 126 77-33-144 111-96-146-13-58-136-58 135-146 13 111 97-33 143ZM233-120l65-281L80-590l288-25 112-265 112 265 288 25-218 189 65 281-247-149-247 149Zm247-361Z",
    shuffle: "M560-160v-80h104L537-367l57-57 126 126v-102h80v240H560Zm-344 0-56-56 504-504H560v-80h240v240h-80v-104L216-160Zm151-377L160-744l56-56 207 207-56 56Z",
    swap_vert: "M320-440v-287L217-624l-57-56 200-200 200 200-57 56-103-103v287h-80ZM600-80 400-280l57-56 103 103v-287h80v287l103-103 57 56L600-80Z",
    upload: "M440-320v-326L336-542l-56-58 200-200 200 200-56 58-104-104v326h-80ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z"
  };
  function icon(name, opts){
    opts = opts || {};
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('class', 'ico' + (opts.cls ? ' '+opts.cls : ''));
    if(opts.size){ svg.setAttribute('width', opts.size); svg.setAttribute('height', opts.size); }
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || '');
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  // Circular progress ring for tab tickets.
  function progressRing(pct, opts){
    opts = opts || {};
    var size = opts.size || 34;
    var stroke = opts.stroke || 3.5;
    var r = (size - stroke) / 2;
    var circumference = 2 * Math.PI * r;
    var offset = circumference * (1 - Math.max(0, Math.min(100, pct)) / 100);
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('class', 'progress-ring' + (opts.cls ? ' '+opts.cls : ''));

    var track = document.createElementNS(ns, 'circle');
    track.setAttribute('cx', size/2); track.setAttribute('cy', size/2); track.setAttribute('r', r);
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', 'currentColor');
    track.setAttribute('class', 'progress-ring-track');
    track.setAttribute('stroke-width', stroke);
    svg.appendChild(track);

    var fill = document.createElementNS(ns, 'circle');
    fill.setAttribute('cx', size/2); fill.setAttribute('cy', size/2); fill.setAttribute('r', r);
    fill.setAttribute('fill', 'none');
    fill.setAttribute('stroke', 'currentColor');
    fill.setAttribute('class', 'progress-ring-fill');
    fill.setAttribute('stroke-width', stroke);
    fill.setAttribute('stroke-linecap', 'round');
    fill.setAttribute('stroke-dasharray', circumference);
    fill.setAttribute('stroke-dashoffset', offset);
    fill.setAttribute('transform', 'rotate(-90 ' + size/2 + ' ' + size/2 + ')');
    svg.appendChild(fill);

    if(opts.centerContent){
      var wrap2 = el('div',{class:'progress-ring-wrap'});
      wrap2.appendChild(svg);
      wrap2.appendChild(el('span',{class:'progress-ring-label'},[opts.centerContent]));
      return wrap2;
    }
    if(opts.showLabel){
      var wrap = el('div',{class:'progress-ring-wrap'});
      wrap.appendChild(svg);
      wrap.appendChild(el('span',{class:'progress-ring-label'},[text(Math.round(pct)+'%')]));
      return wrap;
    }
    return svg;
  }

  // Flag + count shown inside the progress ring in place of the percentage when a tab
  // has flagged words.
  function flagCenterContent(count){
    var frag = el('span',{class:'ring-flag-center'});
    var flagIco = icon('flag',{cls:'ring-flag-ico'});
    frag.appendChild(flagIco);
    frag.appendChild(el('span',{class:'ring-flag-count'},[text(count)]));
    return frag;
  }

  // ---- Folder system: deck-card artwork ----
  // Three hand-drawn shapes (x/y/z), each with one true geometry reused across four color
  // presets (bright/dark/dusty/soft). A hue-rotate filter layers on top for further variety
  // on top of the chosen preset. Every gradient/clip/filter id gets a per-instance suffix so
  // multiple folders rendered at once on the Library screen never collide.
  var SVGNS = 'http://www.w3.org/2000/svg';

  var FOLDER_SHAPES = ['x','y','z'];
  var FOLDER_STYLES = ['bright','dark','dusty','soft'];

  // Hex pairs traced from the original folder SVGs.
  var FOLDER_COLORS = {
    x: {
      bright: {g1a:'#901e1d', g1b:'#ed3533', g2a:'#8d1f1f', g2b:'#ae2425'},
      dark:   {g1a:'#581312', g1b:'#9b2221', g2a:'#431919', g2b:'#700f11'},
      dusty:  {g1a:'#ab6565', g1b:'#bc8484', g2a:'#904646', g2b:'#9f5050'},
      soft:   {g1a:'#c7605f', g1b:'#ed9494', g2a:'#b65757', g2b:'#d16060'}
    },
    y: {
      bright: {g1a:'#ce2728', g1b:'#e42627', g2a:'#ce2728', g2b:'#e42627'},
      dark:   {g1a:'#581312', g1b:'#9b2221', g2a:'#581312', g2b:'#9b2221'},
      dusty:  {g1a:'#ab6565', g1b:'#bc8484', g2a:'#ab6565', g2b:'#bc8484'},
      soft:   {g1a:'#b65757', g1b:'#d16060', g2a:'#b65757', g2b:'#d16060'}
    },
    z: {
      bright: {g1a:'#901e1d', g1b:'#ed3533', g2a:'#8d1f1f', g2b:'#ae2425'},
      dark:   {g1a:'#581312', g1b:'#9b2221', g2a:'#431919', g2b:'#700f11'},
      dusty:  {g1a:'#ab6565', g1b:'#bc8484', g2a:'#904646', g2b:'#9f5050'},
      soft:   {g1a:'#c7605f', g1b:'#ed9494', g2a:'#b65757', g2b:'#d16060'}
    }
  };

  function svgEl(tag, attrs){
    var e = document.createElementNS(SVGNS, tag);
    for(var k in attrs){ if(attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]); }
    return e;
  }
  function linearGradient(id, x1,y1,x2,y2, stopAVar, stopBVar){
    var g = svgEl('linearGradient', {id:id, x1:x1, y1:y1, x2:x2, y2:y2, gradientUnits:'userSpaceOnUse'});
    g.appendChild(svgEl('stop', {offset:'0', 'stop-color':'var('+stopAVar+')'}));
    g.appendChild(svgEl('stop', {offset:'1', 'stop-color':'var('+stopBVar+')'}));
    return g;
  }

  // Each shape builder takes a unique per-instance suffix (so ids never collide across
  // multiple simultaneously-rendered folders) and returns a complete <svg> element.
  function buildFolderX(uidSuffix){
    var svg = svgEl('svg', {viewBox:'0 0 80 80', class:'folder-art'});
    var defs = svgEl('defs');
    var g1id = 'fx-g1-'+uidSuffix, g2id = 'fx-g2-'+uidSuffix;
    defs.appendChild(linearGradient(g1id, 40,80,40,0, '--g1a','--g1b'));
    defs.appendChild(linearGradient(g2id, 46.62,80,46.62,23.8, '--g2a','--g2b'));
    svg.appendChild(defs);

    var g = svgEl('g');
    g.appendChild(svgEl('path', {fill:'url(#'+g1id+')', d:'M80,5.46v69.08c0,3.01-2.45,5.46-5.46,5.46H5.46c-3.01,0-5.46-2.45-5.46-5.46V14.53c0-3.01,2.45-5.46,5.46-5.46h32.41c1.17,0,2.31-.37,3.25-1.07l9.35-6.93c.94-.7,2.07-1.07,3.25-1.07h20.83c3.01,0,5.46,2.45,5.46,5.46Z'}));

    var papers = svgEl('g');
    var paperStyle = {fill:'#fff', stroke:'#e1c8c7', 'stroke-miterlimit':'10', 'stroke-width':'.25'};
    papers.appendChild(svgEl('path', Object.assign({d:'M6.78,27.97h8.44v48.4H6.78c-1.51,0-2.73-1.22-2.73-2.73V30.7c0-1.51,1.22-2.73,2.73-2.73Z'}, paperStyle)));
    papers.appendChild(svgEl('rect', Object.assign({x:'7.38', y:'20.54', width:'58.86', height:'48.4', rx:'2.73', ry:'2.73', transform:'translate(5.8 -4.2) rotate(7.08)'}, paperStyle)));
    papers.appendChild(svgEl('path', Object.assign({d:'M10.46,29.32h4.03v48.4h-4.03c-1.51,0-2.73-1.22-2.73-2.73v-42.94c0-1.51,1.22-2.73,2.73-2.73Z'}, paperStyle)));
    papers.appendChild(svgEl('path', Object.assign({d:'M12.6,29.94h4.03v48.4h-4.03c-1.51,0-2.73-1.22-2.73-2.73v-42.94c0-1.51,1.22-2.73,2.73-2.73Z'}, paperStyle)));
    papers.appendChild(svgEl('path', Object.assign({d:'M13.84,27.97h4.03v48.4h-4.03c-1.51,0-2.73-1.22-2.73-2.73V30.7c0-1.51,1.22-2.73,2.73-2.73Z'}, paperStyle)));
    g.appendChild(papers);

    g.appendChild(svgEl('path', {fill:'url(#'+g2id+')', d:'M80,23.8v50.74c0,3.02-2.44,5.46-5.46,5.46H13.25V26.53c0-1.51,1.22-2.73,2.73-2.73h64.02Z'}));
    svg.appendChild(g);
    return svg;
  }

  function buildFolderY(uidSuffix){
    var svg = svgEl('svg', {viewBox:'0 0 80 80', class:'folder-art'});
    var defs = svgEl('defs');
    var g1id = 'fy-g1-'+uidSuffix, g2id = 'fy-g2-'+uidSuffix;
    var filterId = 'fy-blur-'+uidSuffix, clipId = 'fy-clip-'+uidSuffix;

    var filter = svgEl('filter', {id:filterId, x:'-30%', y:'-30%', width:'160%', height:'160%'});
    filter.appendChild(svgEl('feGaussianBlur', {in:'SourceGraphic', stdDeviation:'4.5'}));
    defs.appendChild(filter);

    var clip = svgEl('clipPath', {id:clipId});
    clip.appendChild(svgEl('path', {d:'M79.17,29.74l-1.55,44.98c-.1,2.94-2.52,5.28-5.48,5.28H7.82c-2.95,0-5.39-2.34-5.48-5.28L.51,20.41h16.5c1.36,0,2.67.5,3.67,1.4l7.26,6.52c1.01.9,2.32,1.4,3.67,1.4h47.56Z'}));
    defs.appendChild(clip);

    defs.appendChild(linearGradient(g1id, 40,80,40,0, '--g1a','--g1b'));
    defs.appendChild(linearGradient(g2id, 39.84,80,39.84,20.41, '--g2a','--g2b'));
    svg.appendChild(defs);

    var backD = 'M80,5.64l-.5,14.77-.24,6.75-.08,2.58-1.55,44.98c-.1,2.94-2.52,5.28-5.48,5.28H7.82c-2.95,0-5.39-2.34-5.48-5.28L.51,20.41,0,5.64C-.1,2.56,2.39,0,5.49,0h69.03c3.1,0,5.59,2.56,5.48,5.64Z';
    var paperStyle = {fill:'#fff', stroke:'#e2c9c8', 'stroke-miterlimit':'10', 'stroke-width':'.25'};
    function paperGroup(){
      var pg = svgEl('g');
      pg.appendChild(svgEl('rect', Object.assign({x:'27.93', y:'16.58', width:'35.65', height:'36.16', rx:'2.74', ry:'2.74', transform:'translate(3.7 -4.41) rotate(5.75)'}, paperStyle)));
      pg.appendChild(svgEl('rect', Object.assign({x:'22.17', y:'11.76', width:'35.65', height:'36.16', rx:'2.74', ry:'2.74'}, paperStyle)));
      pg.appendChild(svgEl('path', Object.assign({d:'M51,42.61l-29.67,5.44c-1.49.27-2.92-.71-3.19-2.19l-5.59-30.19c-.27-1.48.71-2.91,2.2-3.18l29.67-5.44c1.49-.27,2.92.71,3.19,2.19l5.59,30.19c.27,1.48-.71,2.91-2.2,3.18Z'}, paperStyle)));
      return pg;
    }

    var g = svgEl('g');
    g.appendChild(svgEl('path', {fill:'url(#'+g1id+')', d:backD}));
    g.appendChild(paperGroup());

    var blurred = svgEl('g', {'clip-path':'url(#'+clipId+')', filter:'url(#'+filterId+')'});
    blurred.appendChild(svgEl('path', {fill:'url(#'+g1id+')', d:backD}));
    blurred.appendChild(paperGroup());
    g.appendChild(blurred);

    g.appendChild(svgEl('path', {fill:'#f3e9e9', opacity:'.3', d:'M79.17,29.74l-1.55,44.98c-.1,2.94-2.52,5.28-5.48,5.28H7.82c-2.95,0-5.39-2.34-5.48-5.28L.51,20.41h16.5c1.36,0,2.67.5,3.67,1.4l7.26,6.52c1.01.9,2.32,1.4,3.67,1.4h47.56Z'}));
    svg.appendChild(g);
    return svg;
  }

  function buildFolderZ(uidSuffix){
    var svg = svgEl('svg', {viewBox:'0 0 80 80', class:'folder-art'});
    var defs = svgEl('defs');
    var g1id = 'fz-g1-'+uidSuffix, g2id = 'fz-g2-'+uidSuffix;
    defs.appendChild(linearGradient(g1id, 40,80,40,0, '--g1a','--g1b'));
    defs.appendChild(linearGradient(g2id, 40,80,40,40, '--g2a','--g2b'));
    svg.appendChild(defs);

    var g = svgEl('g');
    g.appendChild(svgEl('path', {fill:'url(#'+g1id+')', d:'M80,14.01v60.53c0,3.01-2.45,5.46-5.46,5.46H5.46c-3.01,0-5.46-2.45-5.46-5.46V5.46C0,2.45,2.45,0,5.46,0h21.15c1.15,0,2.26.35,3.19,1.02l9.06,6.51c.93.66,2.04,1.02,3.19,1.02h32.5c3.01,0,5.46,2.45,5.46,5.46Z'}));

    var rectsData = [
      {x:'9.35', y:'17.49', transform:'translate(-4.28 3.76) rotate(-7.3)'},
      {x:'28.83', y:'23.2', transform:'translate(-3.42 4.24) rotate(-5.01)'},
      {x:'36.93', y:'20.2', transform:null},
      {x:'19.34', y:'29.33', transform:'translate(-14.52 78.03) rotate(-82.4)'}
    ];
    var papers = svgEl('g');
    rectsData.forEach(function(r){
      var pair = svgEl('g');
      var base = {x:r.x, y:r.y, width:'35.95', height:'35.95', rx:'2.73', ry:'2.73'};
      if(r.transform) base.transform = r.transform;
      pair.appendChild(svgEl('rect', Object.assign({fill:'#fff'}, base)));
      pair.appendChild(svgEl('rect', Object.assign({fill:'none', stroke:'#e2c9c8', 'stroke-miterlimit':'10', 'stroke-width':'.25'}, base)));
      papers.appendChild(pair);
    });
    g.appendChild(papers);

    g.appendChild(svgEl('path', {fill:'url(#'+g2id+')', d:'M80,40v34.54c0,3.01-2.45,5.46-5.46,5.46H5.46c-3.01,0-5.46-2.45-5.46-5.46v-34.54h80Z'}));
    svg.appendChild(g);
    return svg;
  }

  var FOLDER_BUILDERS = {x:buildFolderX, y:buildFolderY, z:buildFolderZ};

  // Builds a complete, ready-to-insert folder SVG for a given shape/style/hue combination.
  // uidSuffix must be unique per rendered instance (e.g. the deck's own id) so that multiple
  // folders on screen at once never share gradient/clip/filter ids.
  function renderFolder(shape, style, hue, uidSuffix){
    shape = FOLDER_BUILDERS[shape] ? shape : 'x';
    style = FOLDER_COLORS[shape][style] ? style : 'bright';
    var svg = FOLDER_BUILDERS[shape](uidSuffix);
    var colors = FOLDER_COLORS[shape][style];
    svg.style.setProperty('--g1a', colors.g1a);
    svg.style.setProperty('--g1b', colors.g1b);
    svg.style.setProperty('--g2a', colors.g2a);
    svg.style.setProperty('--g2b', colors.g2b);
    if(hue){ svg.style.filter = 'hue-rotate(' + hue + 'deg)'; }
    return svg;
  }

  // Picks a random shape/style/hue combo for a freshly-created deck.
  function randomFolderConfig(){
    var shape = FOLDER_SHAPES[Math.floor(Math.random()*FOLDER_SHAPES.length)];
    var style = FOLDER_STYLES[Math.floor(Math.random()*FOLDER_STYLES.length)];
    var hue = Math.floor(Math.random()*360);
    return {folderShape:shape, folderStyle:style, folderHue:hue};
  }

  var FOLDER_SHAPE_LABELS = {x:'Classic', y:'Frosted', z:'Layered'};
  var FOLDER_STYLE_LABELS = {bright:'Bright', dark:'Dark', dusty:'Dusty', soft:'Soft'};

  // Picker state lives at module scope so it survives the full re-render every chip click triggers.
  var folderPickerChangeTimers = {};
  var folderPickerPendingCfg = {};
  var folderEditorDrafts = {};

  // Folder appearance editor: an overlay (desktop) / full-screen (mobile) wrapping the
  // picker. Changes go to a draft and only reach storage when Save is tapped. The draft is
  // kept in folderEditorDrafts because each re-render would otherwise rebuild it from the
  // unsaved deck entry and drop the last click.
  function renderFolderEditor(){
    var pinEntry = state.libraryIndex.find(function(d){ return d.id === state.activeDeckId; });
    if(!pinEntry) { state.folderEditorOpen = false; return el('div'); }
    if(!folderEditorDrafts[state.activeDeckId]){
      folderEditorDrafts[state.activeDeckId] = {folderShape: pinEntry.folderShape||'x', folderStyle: pinEntry.folderStyle||'bright', folderHue: pinEntry.folderHue||0};
    }
    var draft = folderEditorDrafts[state.activeDeckId];

    var overlay = el('div',{class:'sheet-overlay folder-editor-overlay', onclick:function(e){ if(e.target===e.currentTarget){ state.folderEditorOpen=false; delete folderEditorDrafts[state.activeDeckId]; render(); } }});
    var sheet = el('div',{class:'sheet folder-editor-sheet'});
    sheet.appendChild(el('h3',{},[text('EDIT FOLDER APPEARANCE')]));
    sheet.appendChild(renderFolderPicker(draft, function(cfg){ draft.folderShape=cfg.folderShape; draft.folderStyle=cfg.folderStyle; draft.folderHue=cfg.folderHue; }, state.activeDeckId+'-editor'));
    sheet.appendChild(el('div',{class:'options-bar mt-10'},[
      el('button',{class:'primary-btn grow', onclick:function(){
        pinEntry.folderShape = draft.folderShape;
        pinEntry.folderStyle = draft.folderStyle;
        pinEntry.folderHue = draft.folderHue;
        saveLibraryIndex();
        state.folderEditorOpen = false;
        delete folderEditorDrafts[state.activeDeckId];
        render();
        showToast('Folder look saved~');
      }},[icon('check_circle'), text(' Save')]),
      el('button',{class:'ghost-btn', onclick:function(){ state.folderEditorOpen=false; delete folderEditorDrafts[state.activeDeckId]; render(); }},[text('Cancel')])
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }

  // Reusable folder shape/style/hue picker with a live preview.
  // cfg: {folderShape, folderStyle, folderHue}. onChange(cfg) fires (debounced) on any change.
  // previewSeed: a stable string for gradient-id uniqueness (deck id when editing, a fixed string for a new deck).
  function renderFolderPicker(cfg, onChange, previewSeed){
    // If a change is still debouncing, build on that pending config: the caller's cfg
    // won't reflect it yet.
    if(folderPickerPendingCfg[previewSeed]){
      cfg = folderPickerPendingCfg[previewSeed];
    }
    var wrap = el('div',{class:'folder-picker'});

    // Debounced so slider drags and rapid chip taps cause one write once they settle.
    function notifyChange(){
      folderPickerPendingCfg[previewSeed] = cfg;
      clearTimeout(folderPickerChangeTimers[previewSeed]);
      folderPickerChangeTimers[previewSeed] = setTimeout(function(){
        delete folderPickerPendingCfg[previewSeed];
        onChange(cfg);
      }, 400);
    }

    var previewBox = el('div',{class:'folder-picker-preview'});
    function repaintPreview(){
      previewBox.innerHTML = '';
      previewBox.appendChild(renderFolder(cfg.folderShape, cfg.folderStyle, cfg.folderHue, previewSeed+'-preview'));
    }
    repaintPreview();
    wrap.appendChild(previewBox);

    var shapeRow = el('div',{class:'toggle-row'});
    FOLDER_SHAPES.forEach(function(s){
      shapeRow.appendChild(el('button',{class:'toggle-chip'+(cfg.folderShape===s?' active':''), onclick:function(){
        cfg.folderShape = s; repaintPreview(); render(); notifyChange();
      }},[text(FOLDER_SHAPE_LABELS[s])]));
    });
    wrap.appendChild(shapeRow);

    var styleRow = el('div',{class:'toggle-row'});
    FOLDER_STYLES.forEach(function(s){
      styleRow.appendChild(el('button',{class:'toggle-chip'+(cfg.folderStyle===s?' active':''), onclick:function(){
        cfg.folderStyle = s; repaintPreview(); render(); notifyChange();
      }},[text(FOLDER_STYLE_LABELS[s])]));
    });
    wrap.appendChild(styleRow);

    var hueRow = el('div',{class:'hue-row'});
    var hueSlider = el('input',{type:'range', min:'0', max:'359', value:String(cfg.folderHue), class:'hue-slider-input',
      oninput:function(e){ cfg.folderHue = parseInt(e.target.value,10); repaintPreview(); notifyChange(); }
    });
    hueRow.appendChild(el('span',{class:'hue-label'},[text('Hue')]));
    hueRow.appendChild(hueSlider);
    wrap.appendChild(hueRow);

    wrap.appendChild(el('button',{class:'ghost-btn mt-8', onclick:function(){
      var fresh = randomFolderConfig();
      cfg.folderShape = fresh.folderShape; cfg.folderStyle = fresh.folderStyle; cfg.folderHue = fresh.folderHue;
      repaintPreview();
      hueSlider.value = String(cfg.folderHue);
      render();
      notifyChange();
    }},[icon('shuffle'), text(' Random')]));

    return wrap;
  }

  // ---------------- Navigation: addresses + back button ----------------
  // Every screen has an address (#/deck/<id>/tab/<name> etc.), and every open pop-up adds
  // one history "layer" on top of its screen, so the device back button closes pop-ups
  // first, then steps back through screens. The app keeps a mirror of the history entries
  // it created (nav.entries, saved per tab in sessionStorage so it survives a refresh);
  // after every render, syncHistory() makes the browser history match what's on screen:
  //   - a pop-up opened    -> push a layer entry
  //   - a pop-up closed    -> step back over its layer entry
  //   - an earlier screen  -> step back to it (so in-app Back buttons and device back agree)
  //   - a new screen       -> push it (drill <-> results swap in place instead)
  var NAV_KEY = 'vocab-drill-nav';
  var nav = { ready:false, entries:[], idx:0, awaiting:false, applying:false, replaceNext:false };

  function routeHash(){
    var base = state.activeDeckId ? '#/deck/' + encodeURIComponent(state.activeDeckId) : '#/';
    switch(state.screen){
      case 'library': return '#/';
      case 'manageLibrary': return '#/manage';
      case 'onboarding': return '#/onboarding';
      case 'welcome': return '#/welcome';
      case 'chapterDetail': return base + '/tab/' + encodeURIComponent(state.activeChapter || '');
      case 'addmore': return base + '/add';
      case 'customtest': return base + '/custom';
      case 'reorder': return base + '/reorder';
      case 'flaggedDetail': return base + '/flagged';
      case 'exportPicker': return base + '/export';
      case 'drill': return base + '/drill';
      case 'summary': return base + '/summary';
      default: return base; // select, loader, loadError
    }
  }

  // Pop-ups that the back button closes, topmost first.
  var NAV_OVERLAYS = [
    {open:function(){ return !!state.importCollision; }, close:null}, // must be answered: back can't dismiss it
    {open:function(){ return !!state.confirmDialog; }, close:function(){ state.confirmDialog = null; }},
    {open:function(){ return state.folderEditorOpen; }, close:function(){ state.folderEditorOpen = false; delete folderEditorDrafts[state.activeDeckId]; }},
    {open:function(){ return state.showShortcutHint; }, close:function(){ state.showShortcutHint = false; }},
    {open:function(){ return !!state.modeSheet; }, close:function(){ state.modeSheet = null; }},
    {open:function(){ return state.sideMenuOpen; }, close:function(){ state.sideMenuOpen = false; state.sideMenuContext = null; }},
    {open:function(){ return state.screen === 'library' && state.newDeckPromptOpen; }, close:function(){ state.newDeckPromptOpen = false; state.newDeckDraftFolder = null; state.newDeckDraftName = ''; }}
  ];
  function overlayCount(){ return NAV_OVERLAYS.filter(function(o){ return o.open(); }).length; }
  function closeTopOverlays(n){
    for(var i=0; i<NAV_OVERLAYS.length && n>0; i++){
      var o = NAV_OVERLAYS[i];
      if(o.open() && o.close){ o.close(); n--; }
    }
  }

  function isDrillSlot(h){ return /\/(drill|summary)$/.test(h); }
  // Screens that shouldn't stay in history once you've moved on from them.
  function isTransient(h){ return h === '#/welcome' || h === '#/onboarding'; }

  function navSave(){ try{ sessionStorage.setItem(NAV_KEY, JSON.stringify(nav.entries)); }catch(e){} }
  function navPush(entry){
    nav.entries.length = nav.idx + 1;
    nav.entries.push(entry);
    nav.idx++;
    history.pushState({vd:true, idx:nav.idx}, '', entry.hash);
  }
  function navReplace(entry){
    nav.entries[nav.idx] = entry;
    history.replaceState({vd:true, idx:nav.idx}, '', entry.hash);
  }
  // Steps through history ourselves; the resulting popstate resumes syncHistory().
  function navGo(delta){
    nav.awaiting = true;
    history.go(delta);
    setTimeout(function(){
      if(!nav.awaiting) return;
      nav.awaiting = false;
      if(history.state && history.state.vd) nav.idx = history.state.idx;
      syncHistory();
    }, 1500);
  }

  function initNav(){
    try{
      var saved = null;
      try{ saved = JSON.parse(sessionStorage.getItem(NAV_KEY)); }catch(e){}
      var st = history.state;
      var hash = location.hash || '#/';
      if(st && st.vd && saved && saved[st.idx]){
        nav.entries = saved;
        nav.idx = st.idx;
        nav.entries[nav.idx].hash = hash;
      } else {
        nav.entries = [{hash:hash, layers:0}];
        nav.idx = 0;
        history.replaceState({vd:true, idx:0}, '', hash);
      }
      nav.ready = true;
    }catch(e){
      nav.ready = false; // history API unavailable (e.g. sandboxed preview): app still works, just without addresses
    }
  }

  function syncHistory(){
    if(!nav.ready || nav.awaiting || nav.applying || state.screen === 'loading') return;
    try{
      for(var guard=0; guard<12; guard++){
        var want = {hash:routeHash(), layers:overlayCount()};
        var cur = nav.entries[nav.idx];
        if(cur.hash === want.hash && cur.layers === want.layers) break;

        if(nav.replaceNext){
          nav.replaceNext = false;
          if(cur.hash !== want.hash){ navReplace({hash:want.hash, layers:cur.layers}); continue; }
        }
        if(cur.hash === want.hash){
          if(want.layers > cur.layers){ navPush({hash:want.hash, layers:cur.layers + 1}); continue; }
          navGo(want.layers - cur.layers); return;
        }

        var base = nav.idx - cur.layers; // this screen's own (layer 0) entry
        for(var j=base-1; j>=0; j--){
          var e = nav.entries[j];
          if(e && !e.dead && e.layers === 0 && e.hash === want.hash){ navGo(j - nav.idx); return; }
        }
        if(isDrillSlot(cur.hash) && isDrillSlot(want.hash) && cur.layers === 0){ navReplace({hash:want.hash, layers:0}); continue; }
        if(isDrillSlot(cur.hash) && base > 0){ navGo(-(cur.layers + 1)); return; }
        if(cur.layers > 0 || isTransient(cur.hash)){
          for(var k=base+1; k<nav.idx; k++) nav.entries[k].dead = true;
          navReplace({hash:want.hash, layers:0});
          continue;
        }
        navPush({hash:want.hash, layers:0});
      }
    }catch(err){
      nav.ready = false;
    }
    navSave();
  }

  function parseRoute(hash){
    return (hash || '').replace(/^#\/?/, '').split('/').filter(function(p){ return p !== ''; }).map(function(p){
      try{ return decodeURIComponent(p); }catch(e){ return p; }
    });
  }

  // Puts the app on the screen an address describes. Used on boot and on back/forward.
  function applyRoute(hash){
    var p = parseRoute(hash);
    nav.applying = true;
    if(p[0] === 'deck' && p[1]){
      var id = p[1];
      if(!state.libraryIndex.some(function(d){ return d.id === id; })){
        state.activeDeckId = null; state.screen = 'library';
        return finishRoute();
      }
      if(state.activeDeckId === id && loadedDeckId === id){
        applyDeckRoute(p[2], p[3]);
        return finishRoute();
      }
      loadDeck(id, function(){ applyDeckRoute(p[2], p[3]); finishRoute(); });
      return;
    }
    if(p[0] === 'manage') state.screen = 'manageLibrary';
    else if(p[0] === 'onboarding') state.screen = 'onboarding';
    else if(p[0] === 'welcome'){ state.welcomeNameDraft = ''; state.screen = 'welcome'; }
    else { state.activeDeckId = null; state.screen = 'library'; }
    finishRoute();
  }
  function applyDeckRoute(sub, arg){
    if(state.screen === 'loadError') return;
    if(!state.chapterOrder.length){ state.screen = 'loader'; return; }
    if(sub === 'tab' && arg && state.chapters[arg]){
      if(state.activeChapter !== arg || state.screen !== 'chapterDetail'){ state.chapterEditMode = false; state.editingChapterName = false; }
      state.activeChapter = arg;
      state.screen = 'chapterDetail';
    }
    else if(sub === 'add') state.screen = 'addmore';
    else if(sub === 'custom'){ if(state.screen !== 'customtest') state.customTestSelection = []; state.screen = 'customtest'; }
    else if(sub === 'reorder') state.screen = 'reorder';
    else if(sub === 'flagged') state.screen = 'flaggedDetail';
    else if(sub === 'export'){ if(state.screen !== 'exportPicker') state.exportSelection = []; state.screen = 'exportPicker'; }
    else if(sub === 'summary' && state.session) state.screen = 'summary';
    else state.screen = 'select'; // includes a drill that can't be resumed after a refresh
  }
  function finishRoute(){
    nav.applying = false;
    if(nav.ready){
      var cur = nav.entries[nav.idx];
      navReplace({hash:routeHash(), layers:cur ? cur.layers : 0});
    }
    render();
  }

  window.addEventListener('popstate', function(e){
    if(!nav.ready) return;
    var st = e.state;
    if(!st || !st.vd){
      // The address was edited by hand: treat it as a fresh navigation.
      nav.entries.length = nav.idx + 1;
      nav.idx++;
      nav.entries.push({hash:location.hash || '#/', layers:0});
      history.replaceState({vd:true, idx:nav.idx}, '', location.hash || '#/');
      closeTopOverlays(NAV_OVERLAYS.length);
      applyRoute(location.hash);
      return;
    }
    var prevIdx = nav.idx;
    nav.idx = st.idx;
    if(!nav.entries[nav.idx]) nav.entries[nav.idx] = {hash:location.hash || '#/', layers:0};
    if(nav.awaiting){ nav.awaiting = false; syncHistory(); return; }

    var target = nav.entries[nav.idx];
    if(target.dead){ history.go(nav.idx < prevIdx ? -1 : 1); return; }
    navSave();

    if(state.importCollision){ render(); return; } // syncHistory re-adds the entry, keeping the prompt up
    if(state.screen === 'drill' && state.session && target.hash !== routeHash()){
      closeTopOverlays(NAV_OVERLAYS.length);
      state.confirmDialog = { message:'Leave this drill? Your progress so far is already saved.', onYes:endSessionEarly };
      render();
      return;
    }
    if(target.hash === routeHash()){
      closeTopOverlays(overlayCount() - target.layers);
      render();
      return;
    }
    closeTopOverlays(NAV_OVERLAYS.length);
    applyRoute(target.hash);
  });

  function render(){
    renderScreen();
    syncHistory();
  }

  function renderScreen(){
    app.innerHTML = '';
    if(state.screen === 'loading'){
      app.appendChild(el('div',{class:'loading-screen'},[text('Loading...')]));
      return;
    }
    if(state.screen === 'welcome'){
      app.appendChild(renderWelcome());
      return;
    }
    app.appendChild(renderTopbar());
    var main = el('main', {});
    if(state.screen === 'library') main.appendChild(renderLibrary());
    else if(state.screen === 'loadError') main.appendChild(renderLoadError());
    else if(state.screen === 'onboarding') main.appendChild(renderOnboarding());
    else if(state.screen === 'loader') main.appendChild(renderLoader());
    else if(state.screen === 'addmore') main.appendChild(renderAddMore());
    else if(state.screen === 'customtest') main.appendChild(renderCustomTest());
    else if(state.screen === 'select') main.appendChild(renderSelect());
    else if(state.screen === 'chapterDetail') main.appendChild(renderChapterDetail());
    else if(state.screen === 'reorder') main.appendChild(renderReorderChapters());
    else if(state.screen === 'manageLibrary') main.appendChild(renderManageLibrary());
    else if(state.screen === 'flaggedDetail') main.appendChild(renderFlaggedDetail());
    else if(state.screen === 'exportPicker') main.appendChild(renderExportPicker());
    else if(state.screen === 'drill') main.appendChild(renderDrillRouter());
    else if(state.screen === 'summary') main.appendChild(renderSummary());
    app.appendChild(main);
    if(state.modeSheet) app.appendChild(renderModeSheet());
    if(state.confirmDialog) app.appendChild(renderConfirmDialog());
    if(state.importCollision) app.appendChild(renderImportCollisionDialog());
    if(state.toast) app.appendChild(renderToast());
    if(state.showShortcutHint) app.appendChild(renderShortcutHint());
    if(state.sideMenuOpen){
      if(state.sideMenuContext === 'deck') app.appendChild(renderSideMenu('Deck Settings', buildDeckMenuBody));
      else if(state.sideMenuContext === 'library') app.appendChild(renderSideMenu('Library', buildLibraryMenuBody));
    }
    if(state.folderEditorOpen) app.appendChild(renderFolderEditor());
  }

  // ---- Shared slide-out side menu ----
  // One panel component for both the deck menu and the library menu.
  function renderSideMenu(title, buildBody){
    var overlay = el('div',{class:'side-menu-overlay open', onclick:function(e){
      if(e.target === e.currentTarget) closeSideMenu();
    }});
    var panel = el('div',{class:'side-menu-panel'});
    panel.appendChild(el('div',{class:'side-menu-header'},[
      el('h2',{},[text(title)]),
      el('button',{class:'side-menu-close', onclick:closeSideMenu},[icon('arrow_back',{cls:'shuffle-flip'})])
    ]));
    var body = el('div',{class:'side-menu-body'});
    buildBody(body);
    panel.appendChild(body);
    overlay.appendChild(panel);
    return overlay;
  }
  function openSideMenu(context){
    state.sideMenuOpen = true;
    state.sideMenuContext = context;
    render();
  }
  function closeSideMenu(){
    state.sideMenuOpen = false;
    state.sideMenuContext = null;
    render();
  }
  function sideMenuSection(body, label, children){
    var section = el('div',{class:'side-menu-section'});
    if(label) section.appendChild(el('div',{class:'side-menu-section-label'},[text(label)]));
    children.forEach(function(c){ if(c) section.appendChild(c); });
    body.appendChild(section);
  }

  // Deck-level menu content.
  function buildDeckMenuBody(body){
    var statusText, statusColor;
    if(state.storageStatus === 'ok'){
      statusText = storage.isNative ? 'Auto-saving to this browser' : 'Auto-saving to this browser (local only — won\'t follow you to another device)';
      statusColor = '';
    }
    else if(state.storageStatus === 'unavailable'){ statusText = 'Auto-save unavailable — export to keep progress'; statusColor = ' dot-error'; }
    else { statusText = 'Checking storage…'; statusColor = ' dot-checking'; }
    body.appendChild(el('div',{class:'status-line'},[el('span',{class:'dot' + statusColor}),text(statusText)]));
    if(state.storageStatus === 'unavailable' && storage.isNative && state.saveErrorDetail){
      body.appendChild(el('p',{class:'error-detail'},[text('Detail: ' + state.saveErrorDetail + (state.saveErrorPayloadSize ? ' (payload: ' + state.saveErrorPayloadSize + ' chars)' : ''))]));
    }

    var pinEntry = state.activeDeckId ? state.libraryIndex.find(function(d){ return d.id === state.activeDeckId; }) : null;

    // ---- Deck identity: favourite + folder appearance ----
    if(pinEntry){
      var isPinned = pinEntry.pinned;
      var favIconSettings = icon(isPinned ? 'favorite_fill' : 'favorite');
      favIconSettings.style.color = 'var(--red)';
      sideMenuSection(body, 'DECK', [
        el('button',{class:'toggle-chip'+(isPinned?' active':''), onclick:function(){ togglePin(state.activeDeckId); }},[favIconSettings, text(isPinned ? ' Favourited — tap to remove' : ' Favourite this deck')]),
        el('button',{class:'toggle-chip', onclick:function(){ state.folderEditorOpen = true; render(); }},[icon('folder_copy'), text(' Edit folder appearance')])
      ]);
    }

    // ---- Study preferences ----
    var shortcutToggle = el('button',{class:'toggle-chip'+(state.keyboardShortcutsEnabled?' active':''), onclick:function(){
      state.keyboardShortcutsEnabled = !state.keyboardShortcutsEnabled;
      saveGlobalPrefs();
      render();
    }},[icon('keyboard_command_key'), text(' Keyboard shortcuts: ' + (state.keyboardShortcutsEnabled ? 'on' : 'off'))]);
    var reminderToggle = state.keyboardShortcutsEnabled ? el('button',{class:'toggle-chip'+(!state.dismissShortcutHints?' active':''), onclick:function(){
      state.dismissShortcutHints = !state.dismissShortcutHints;
      saveGlobalPrefs();
      render();
    }},[icon('chat_dashed'), text(' Shortcut reminders: ' + (state.dismissShortcutHints ? 'off' : 'on'))]) : null;
    var onboardingBtn = el('button',{class:'toggle-chip', onclick:function(){ state.sideMenuOpen=false; state.sideMenuContext=null; state.screen='onboarding'; render(); }},[icon('auto_stories'), text(' View onboarding')]);
    sideMenuSection(body, 'STUDY PREFERENCES', [shortcutToggle, reminderToggle, onboardingBtn]);

    // ---- Backup & sharing ----
    var backupChildren = [];
    if(state.chapterOrder.length > 0){
      backupChildren.push(el('button',{class:'primary-btn', onclick:exportState},[icon('download'), text(' Export progress backup (.json)')]));
      backupChildren.push(el('button',{class:'ghost-btn', onclick:function(){ state.exportSelection=[]; state.screen='exportPicker'; closeSideMenu(); }},[icon('folder_copy'), text(' Export a shareable set (.json)')]));
    }
    var fileInput2 = el('input',{type:'file', accept:'.json', class:'file-input', onchange:function(e){ if(e.target.files[0]) importStateFile(e.target.files[0]); }});
    backupChildren.push(el('button',{class:'ghost-btn', onclick:function(){ fileInput2.click(); }},[icon('upload'), text(' Import a .json file')]));
    backupChildren.push(fileInput2);
    backupChildren.push(el('button',{class:'ghost-btn', onclick:function(){
      askConfirm('Duplicate "' + (state.deckName||'this deck') + '"? A full copy (tabs, vocab, and progress) will be created as a new deck.', function(){
        duplicateDeck(state.activeDeckId);
      });
    }},[icon('folder_copy'), text(' Duplicate this deck')]));
    sideMenuSection(body, 'BACKUP & SHARING', backupChildren);

    // ---- Danger zone: everything destructive lives together ----
    var dangerChildren = [];
    if(state.chapterOrder.length > 0){
      dangerChildren.push(el('div',{class:'reset-progress-zone'},[
        el('div',{class:'dz-title'},[text('RESET PROGRESS ONLY')]),
        el('p',{class:'zone-note'},[text('Clears seen/correct/wrong stats and bookmarks on every word — keeps all your tabs and vocab exactly as they are.')]),
        el('button',{class:'ghost-btn', onclick:function(){
          askConfirm('Reset stats (seen/correct/wrong/bookmarks) on every word? Your chapters and vocab stay untouched.', function(){
            var result = resetAllProgress();
            saveToStorage();
            state.screen = 'select';
            closeSideMenu();
            showToast('Progress reset on ' + result.wordCount + ' word' + (result.wordCount===1?'':'s') + ' — all fresh now~');
          });
        }},[icon('history'), text(' Reset progress only')])
      ]));
    }
    dangerChildren.push(el('div',{class:'danger-zone'},[
      el('div',{class:'dz-title'},[text('DELETE THIS DECK')]),
      el('p',{class:'zone-note'},[text('Removes "' + (state.deckName || 'this deck') + '" entirely and takes you back to your library list.')]),
      el('button',{class:'ghost-btn danger-btn', onclick:function(){
        askConfirm('Delete "' + (state.deckName||'this deck') + '" entirely? All its tabs and progress will be lost unless you exported a backup.', function(){
          var id = state.activeDeckId;
          deleteDeckEntirely(id);
          state.screen = 'library';
          closeSideMenu();
        });
      }},[icon('delete'), text(' Delete this deck')])
    ]));
    sideMenuSection(body, 'DANGER ZONE', dangerChildren);
  }

  // Library-level menu content.
  function buildLibraryMenuBody(body){
    sideMenuSection(body, null, [
      el('button',{class:'toggle-chip', onclick:function(){ closeSideMenu(); state.screen='manageLibrary'; render(); }},[icon('swap_vert'), text(' Manage library (reorder / delete)')])
    ]);
    var fileInputLib = el('input',{type:'file', accept:'.json', class:'file-input', onchange:function(e){ if(e.target.files[0]) importStateFile(e.target.files[0]); }});
    sideMenuSection(body, 'BACKUP YOUR WHOLE LIBRARY', [
      el('p',{class:'zone-note mb-4'},[text('Every deck, its tabs, vocab, and progress, bundled into one file.')]),
      el('button',{class:'primary-btn', onclick:exportWholeLibrary},[icon('download'), text(' Export whole library (.json)')]),
      el('button',{class:'ghost-btn', onclick:function(){ fileInputLib.click(); }},[icon('upload'), text(' Import a library backup')]),
      fileInputLib
    ]);
    sideMenuSection(body, null, [
      el('button',{class:'toggle-chip', onclick:function(){ closeSideMenu(); state.welcomeNameDraft=''; state.screen='welcome'; render(); }},[icon('auto_stories'), text(' View welcome / restore screen')])
    ]);
    sideMenuSection(body, 'DANGER ZONE', [
      el('div',{class:'danger-zone'},[
        el('div',{class:'dz-title'},[text('WIPE EVERYTHING, START FRESH')]),
        el('p',{class:'zone-note'},[text('Deletes every deck, all progress, and every saved preference. Takes you back to the very first welcome screen. This can\'t be undone unless you\'ve exported backups.')]),
        el('button',{class:'ghost-btn danger-btn', onclick:function(){
          askConfirm('Wipe absolutely everything and start over from scratch? All decks, all progress, and all settings will be gone for good.', function(){
            wipeEverything();
          });
        }},[icon('bomb'), text(' Wipe everything, start fresh')])
      ])
    ]);
  }

  function renderShortcutHint(){
    var overlay = el('div',{class:'sheet-overlay', onclick:function(e){ if(e.target===e.currentTarget){ state.showShortcutHint=false; render(); } }});
    var sheet = el('div',{class:'sheet'});
    sheet.appendChild(el('h3',{},[icon('keyboard_command_key'), text(' KEYBOARD SHORTCUTS')]));
    if(state.shortcutHintMode === 'flip'){
      sheet.appendChild(el('div',{class:'shortcut-list'},[
        el('div',{class:'shortcut-row'},[el('span',{class:'key'},[text('Space')]), el('span',{},[text('Flip the card')])]),
        el('div',{class:'shortcut-row'},[el('span',{class:'key'},[text('Enter')]), el('span',{},[text('Got it')])]),
        el('div',{class:'shortcut-row'},[el('span',{class:'key'},[text('Shift')]), el('span',{},[text('Missed it')])])
      ]));
    } else {
      sheet.appendChild(el('div',{class:'shortcut-list'},[
        el('div',{class:'shortcut-row'},[el('span',{class:'key'},[text('1 – 4')]), el('span',{},[text('Pick that option')])])
      ]));
    }
    sheet.appendChild(el('div',{class:'row'},[
      el('button',{class:'ghost-btn', onclick:function(){
        state.dismissShortcutHints = true;
        saveGlobalPrefs();
        state.showShortcutHint = false;
        render();
      }},[text('Turn off shortcut reminders')]),
      el('button',{class:'primary-btn', onclick:function(){ state.showShortcutHint=false; render(); }},[text('Got it')])
    ]));
    overlay.appendChild(sheet);
    return overlay;
  }

  function renderTimerOnly(){
    var bar = document.getElementById('timerBarFill');
    var wrap = document.getElementById('timerBarWrap');
    if(bar && state.session){
      var pct = Math.max(0, (state.session.timeLeft / state.timerSeconds) * 100);
      bar.style.width = pct + '%';
      if(state.session.timeLeft <= 4) wrap.classList.add('warn'); else wrap.classList.remove('warn');
    }
  }

  function renderTopbar(){
    var actions = el('div',{class:'topbar-actions'});
    actions.appendChild(el('button',{class:'theme-toggle', onclick:toggleTheme, title:'Toggle theme'},[icon(state.theme==='dark'?'light_mode':'dark_mode')]));
    if(state.activeDeckId && state.screen !== 'library'){
      actions.appendChild(el('button',{class:'icon-btn', title:'Switch library', onclick:goToLibrary},[icon('dataset'), text(' LIBRARY')]));
    }
    if(state.screen === 'select' || state.screen === 'loader'){
      actions.appendChild(el('button',{class:'icon-btn', title:'Settings', onclick:function(){ openSideMenu('deck'); }},[icon('menu')]));
    }
    if(state.screen === 'library'){
      actions.appendChild(el('button',{class:'icon-btn', title:'Menu', onclick:function(){ openSideMenu('library'); }},[icon('menu')]));
    }
    var brandChildren;
    if(state.screen === 'library' || !state.activeDeckId){
      var appNameEl;
      if(state.editingAppName){
        appNameEl = el('input',{class:'deck-name-input', value: state.appName || '', placeholder:'Vocab Drill', autofocus:true,
          onblur: function(e){ finishEditAppName(e.target.value); },
          onkeydown: function(e){ if(e.key==='Enter'){ finishEditAppName(e.target.value); } }
        });
      } else {
        appNameEl = el('span',{class:'mark', onclick:function(){ state.editingAppName = true; render(); setTimeout(function(){ var i=document.querySelector('.deck-name-input'); if(i) i.focus(); },0); }},[text(state.appName)]);
      }
      brandChildren = [
        appNameEl,
        el('span',{class:'sub'},[text('Library')])
      ];
    } else {
      var nameEl;
      if(state.editingDeckName){
        nameEl = el('input',{class:'deck-name-input', value: state.deckName || '', placeholder:'Name this deck', autofocus:true,
          onblur: function(e){ finishEditDeckName(e.target.value); },
          onkeydown: function(e){ if(e.key==='Enter'){ finishEditDeckName(e.target.value); } }
        });
      } else {
        nameEl = el('span',{class:'mark', onclick:function(){ state.editingDeckName = true; render(); setTimeout(function(){ var i=document.querySelector('.deck-name-input'); if(i) i.focus(); },0); }},[text(state.deckName || 'Name this deck')]);
      }
      brandChildren = [ nameEl, el('span',{class:'sub'},[text(state.appName)]) ];
    }
    return el('div',{class:'topbar'},[
      el('div',{class:'brand'}, brandChildren),
      actions
    ]);
  }
  function finishEditDeckName(val){
    state.deckName = val.trim();
    state.editingDeckName = false;
    saveToStorage();
    render();
  }
  function finishEditAppName(val){
    val = (val||'').trim();
    state.appName = val || 'Vocab Drill';
    state.editingAppName = false;
    applyAppName();
    saveGlobalPrefs();
    render();
  }

  // ---- Load error screen ----
  // Shown when a deck fails to load from storage (see loadDeck).
  function renderLoadError(){
    var wrap = el('div',{class:'welcome-wrap'});
    var inner = el('div',{class:'welcome-inner'});
    var isRateLimit = state.loadDeckErrorDetail && /rate limit/i.test(state.loadDeckErrorDetail);
    inner.appendChild(el('p',{class:'welcome-eyebrow'},[text('COULDN\'T LOAD THIS LIBRARY')]));
    if(isRateLimit){
      inner.appendChild(el('p',{class:'welcome-sub'},[text('Too many saves happened in a short window and storage is temporarily rate-limited. Your vocab and progress are safe — reload the page to clear this, then come back in.')]));
    } else {
      inner.appendChild(el('p',{class:'welcome-sub'},[text('Something went wrong reading this deck from storage. Your vocab and progress are most likely still there — this looks like a temporary hiccup, not data loss. Try again before doing anything else.')]));
    }
    if(state.loadDeckErrorDetail){
      inner.appendChild(el('p',{class:'welcome-sub error-detail'},[text('Detail: ' + state.loadDeckErrorDetail)]));
    }
    inner.appendChild(el('div',{class:'welcome-actions'},[
      el('button',{class:'primary-btn', onclick:function(){ if(isRateLimit){ window.location.reload(); } else { loadDeck(state.activeDeckId); } }},[icon('history'), text(isRateLimit ? ' Reload the page' : ' Try again')]),
      el('button',{class:'ghost-btn', onclick:goToLibrary},[icon('arrow_back'), text(' Back to libraries')])
    ]));
    wrap.appendChild(inner);
    return wrap;
  }

  // ---- Loader screen ----
  function renderLoader(){
    var wrap = el('div',{class:'loader-wrap'});
    wrap.appendChild(el('h1',{},[text('Paste in your vocab~')]));
    wrap.appendChild(el('p',{},[text('One tab header per line, then '), el('strong',{},[text('term | meaning')]), text(' pairs. Blank lines between tabs are fine, not required.')]));
    var ta = el('textarea',{placeholder:'CH1\nparola | word, term\nfrase | phrase\n\nCH2\n...'});
    ta.value = state.rawInput;
    ta.addEventListener('input', function(e){ state.rawInput = e.target.value; });
    wrap.appendChild(ta);
    wrap.appendChild(el('div',{class:'format-hint'},[text('CH1\nparola | word, term\nfrase | phrase\n\nCH2\n...')]));

    var btn = el('button',{class:'primary-btn', onclick:function(){
      var parsed = parseVocabText(state.rawInput);
      var totalWords = 0;
      parsed.order.forEach(function(k){ totalWords += parsed.chapters[k].length; });
      if(totalWords === 0){
        var existing = wrap.querySelector('.error-msg');
        if(existing) existing.remove();
        wrap.insertBefore(el('div',{class:'error-msg'},[text('Didn\'t find any valid "word | meaning" lines — check the format above.')]), btn);
        return;
      }
      state.chapters = parsed.chapters;
      state.chapterOrder = parsed.order;
      state.screen = 'select';
      saveToStorage();
      render();
    }},[text('Build my deck '), icon('arrow_forward')]);
    wrap.appendChild(btn);

    var fileInput = el('input',{type:'file', accept:'.json', class:'file-input', onchange:function(e){ if(e.target.files[0]) importStateFile(e.target.files[0]); }});
    wrap.appendChild(el('button',{class:'ghost-btn', onclick:function(){ fileInput.click(); }},[text('Import saved progress (.json)')]));
    wrap.appendChild(fileInput);
    return wrap;
  }

  // ---- Add more screen (merge into existing deck, no progress lost) ----
  function renderAddMore(){
    var wrap = el('div',{class:'loader-wrap'});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.addMoreInput=''; state.screen='select'; render(); }},[icon('arrow_back'), text(' Back')]));
    wrap.appendChild(el('h1',{},[text('Add more vocab')]));
    wrap.appendChild(el('p',{},[text('Same format as before. Paste a '), el('strong',{},[text('new tab')]), text(' to add it to your deck, or reuse an '), el('strong',{},[text('existing tab name')]), text(' to add words to it — nothing gets wiped, and duplicate term+meaning pairs are skipped automatically.')]));
    var ta = el('textarea',{placeholder:'CH3\nnuova parola | new word\n\n' + (state.chapterOrder[0]||'CH1') + '\nanother one | added to existing tab'});
    ta.value = state.addMoreInput || '';
    ta.addEventListener('input', function(e){ state.addMoreInput = e.target.value; });
    wrap.appendChild(ta);

    var btn = el('button',{class:'primary-btn', onclick:function(){
      var parsed = parseVocabText(state.addMoreInput || '');
      var totalWords = 0;
      parsed.order.forEach(function(k){ totalWords += parsed.chapters[k].length; });
      if(totalWords === 0){
        var existingErr = wrap.querySelector('.error-msg');
        if(existingErr) existingErr.remove();
        wrap.insertBefore(el('div',{class:'error-msg'},[text('Didn\'t find any valid "term | meaning" lines — check the format above.')]), btn);
        return;
      }
      var result = mergeParsedVocab(parsed);
      state.addMoreInput = '';
      state.screen = 'select';
      saveToStorage();
      render();
      var msg = 'Added ' + result.addedWords + ' word' + (result.addedWords===1?'':'s');
      if(result.addedChapters) msg += ' across ' + result.addedChapters + ' new chapter' + (result.addedChapters===1?'':'s');
      if(result.skippedDupes) msg += ' (' + result.skippedDupes + ' duplicate' + (result.skippedDupes===1?'':'s') + ' skipped)';
      showToast(msg);
    }},[text('Add to deck '), icon('arrow_forward')]);
    wrap.appendChild(btn);
    return wrap;
  }

  // ---- Welcome screen: shown once, on a genuinely first-ever visit ----
  function renderWelcome(){
    var wrap = el('div',{class:'welcome-wrap'});
    var inner = el('div',{class:'welcome-inner'});

    inner.appendChild(el('p',{class:'welcome-eyebrow'},[text('WELCOME TO')]));

    var nameInput = el('input',{
      class:'welcome-name-input', placeholder:'Vocab Drill', autofocus:true,
      value: state.welcomeNameDraft,
      oninput: function(e){ state.welcomeNameDraft = e.target.value; }
    });
    inner.appendChild(nameInput);
    inner.appendChild(el('p',{class:'welcome-sub'},[text('Name this however you like — the vocab torture chamber, your Korean basement, whatever. You can always rename it later from the library screen.')]));

    var restoreFileInput = el('input',{type:'file', accept:'.json', class:'file-input', onchange:function(e){
      if(e.target.files[0]){
        finishWelcome(nameInput.value);
        state.screen = 'library';
        importStateFile(e.target.files[0]);
      }
    }});
    inner.appendChild(el('div',{class:'welcome-actions'},[
      el('button',{class:'ghost-btn', onclick:function(){ finishWelcome(nameInput.value); state.screen='onboarding'; render(); }},[text('Walk me through')]),
      el('button',{class:'primary-btn', onclick:function(){ finishWelcome(nameInput.value); state.screen='library'; render(); }},[text('I\'ll figure it out '), icon('arrow_forward')]),
      el('button',{class:'ghost-btn', onclick:function(){ restoreFileInput.click(); }},[icon('upload'), text(' Restore from a backup file')]),
      restoreFileInput
    ]));

    wrap.appendChild(inner);
    return wrap;
  }
  function finishWelcome(name){
    name = (name||'').trim();
    state.appName = name || 'Vocab Drill';
    state.onboardingSeen = true;
    applyAppName();
    saveGlobalPrefs();
  }

  // ---- Onboarding screen: walkthrough content, text-only for now, illustrations later ----
  function renderOnboarding(){
    var wrap = el('div',{class:'onboarding-wrap'});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen='library'; render(); }},[icon('arrow_back'), text(' Skip to ' + state.appName)]));
    wrap.appendChild(el('h1',{},[text('How ' + state.appName + ' works')]));

    var sections = [
      { title:'Libraries', body:'Everything starts here. Each library is a separate deck — one for Korean, one for Italian, however you want to split things up. Nothing between libraries mixes together.' },
      { title:'Tabs', body:'Inside a deck, your vocab is grouped into tabs. Paste in term | definition pairs with a tab name as a header, and it\u2019ll organize itself.' },
      { title:'Drilling', body:'Tap a tab to see every word in it, or jump straight into Flip cards, Multiple choice, or Match mode. You can also flip the direction \u2014 term to definition, or definition to term.' },
      { title:'Flagging', body:'Bookmark a word any time, or let it flag itself automatically once you\u2019ve missed it more than you\u2019ve gotten it right. Flagged Words gives you one place to review all of it.' },
      { title:'Settings', body:'Every deck has its own Settings panel \u2014 export a backup, share a clean copy of your vocab with someone else, reset your stats, favourite a deck to pin it to the top, or delete it entirely.' }
    ];
    sections.forEach(function(s){
      wrap.appendChild(el('div',{class:'onboarding-section'},[
        el('h3',{},[text(s.title)]),
        el('p',{},[text(s.body)])
      ]));
    });

    wrap.appendChild(el('button',{class:'primary-btn mt-8', onclick:function(){ state.screen='library'; render(); }},[text('Got it — take me in '), icon('arrow_forward')]));
    return wrap;
  }

  // ---- Library screen: the true entry point — pick a deck, or make a new one ----
  function renderLibrary(){
    var wrap = el('div',{class:'library-wrap'});
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('YOUR DECKS')]),
      el('p',{},[text(state.libraryIndex.length ? 'Pick a deck to study or create a new one.' : 'No decks yet — start your first one below.')])
    ]));

    var sorted = state.libraryIndex.map(function(d,i){ return {d:d, i:i}; }).sort(function(a,b){
      var pinDiff = (b.d.pinned?1:0) - (a.d.pinned?1:0);
      if(pinDiff !== 0) return pinDiff;
      return a.i - b.i;
    }).map(function(x){ return x.d; });
    var grid = el('div',{class:'ticket-grid deck-grid'});
    sorted.forEach(function(d){
      var wordCount = d.wordCount || 0;
      var chapterCount = d.chapterCount || 0;
      var favIcon = null;
      if(d.pinned){
        var oppositeHue = ((d.folderHue || 0) + 180) % 360;
        favIcon = icon('favorite_fill',{cls:'pin-ico'});
        favIcon.style.color = 'hsl(' + oppositeHue + ', 70%, 65%)';
      }
      var ticket = el('div',{class:'ticket folder-ticket'+(d.pinned?' pinned':''), 'data-folder-shape':(d.folderShape || 'x'), onclick:function(){ loadDeck(d.id); }},[
        renderFolder(d.folderShape || 'x', d.folderStyle || 'bright', d.folderHue || 0, d.id),
        el('div',{class:'t-left'},[
          favIcon ? el('div',{class:'t-fav-row'},[favIcon]) : null,
          el('div',{class:'t-name kr'},[text(d.name || 'Untitled deck')]),
          el('div',{class:'t-meta'},[text(chapterCount + (chapterCount===1?' tab':' tabs') + ' · ' + wordCount + (wordCount===1?' word':' words'))])
        ])
      ]);
      grid.appendChild(ticket);
    });
    wrap.appendChild(grid);

    if(state.newDeckPromptOpen){
      if(!state.newDeckDraftFolder) state.newDeckDraftFolder = randomFolderConfig();
      var nameInput = el('input',{class:'word-edit-input mb-10', placeholder:'e.g. 5A 어휘, grad med terms, IELTS C1', autofocus:true, value: state.newDeckDraftName,
        oninput:function(e){ state.newDeckDraftName = e.target.value; },
        onkeydown:function(e){ if(e.key==='Enter'){ e.target.blur(); confirmNewDeck(e.target.value); } }
      });
      wrap.appendChild(el('div',{class:'reset-progress-zone mt-16'},[
        el('div',{class:'dz-title'},[text('NEW DECK')]),
        nameInput,
        renderFolderPicker(state.newDeckDraftFolder, function(){}, 'newdeck-draft'),
        el('div',{class:'options-bar'},[
          el('button',{class:'primary-btn grow', onclick:function(){ confirmNewDeck(state.newDeckDraftName); }},[text('Create '), icon('arrow_forward')]),
          el('button',{class:'ghost-btn', onclick:function(){ state.newDeckPromptOpen=false; state.newDeckDraftFolder=null; state.newDeckDraftName=''; render(); }},[text('Cancel')])
        ])
      ]));
    } else {
      wrap.appendChild(el('button',{class:'primary-btn mt-16', onclick:function(){ state.newDeckPromptOpen=true; state.newDeckDraftFolder=null; state.newDeckDraftName=''; render(); setTimeout(function(){ var i=document.querySelector('.word-edit-input'); if(i) i.focus(); },0); }},[text('+ NEW DECK')]));
    }

    return wrap;
  }
  function confirmNewDeck(name){
    name = (name||'').trim();
    state.newDeckPromptOpen = false;
    state.newDeckDraftName = '';
    createNewDeck(name);
  }

  // ---- Select screen ----
  function renderSelect(){
    var wrap = el('div',{});
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('Choose your drill')]),
      el('p',{},[text(totalWordCount() + ' words across ' + state.chapterOrder.length + ' tabs · ' + totalFlagged() + ' flagged/struggling')])
    ]));

    if(state.chapterOrder.length > 1){
      wrap.appendChild(el('div',{class:'final-ticket', onclick:function(){ openModeSheet(state.chapterOrder.slice(), 'all', 'Final Mode'); }},[
        el('div',{},[ el('div',{class:'t-name'},[text('Final Mode')]), el('div',{class:'t-meta'},[text('All ' + state.chapterOrder.length + ' tabs shuffled together')]) ]),
        el('div',{class:'stamp'},[text('EXAM')])
      ]));
      wrap.appendChild(el('div',{class:'final-ticket', onclick:function(){ state.customTestSelection=[]; state.screen='customtest'; render(); }},[
        el('div',{},[ el('div',{class:'t-name'},[text('Custom Test')]), el('div',{class:'t-meta'},[text('Pick which tabs to pull into one drill')]) ]),
        el('div',{class:'stamp stamp-jade'},[text('PICK')])
      ]));
    }
    if(totalFlagged() > 0){
      wrap.appendChild(el('div',{class:'final-ticket flagged-ticket', onclick:function(){ state.screen='flaggedDetail'; render(); }},[
        el('div',{},[ el('div',{class:'t-name'},[text('Flagged Words')]), el('div',{class:'t-meta'},[text(totalFlagged() + ' flagged or missed-more-than-hit')]) ]),
        el('div',{class:'stamp stamp-red'},[text('WEAK')])
      ]));
    }

    var grid = el('div',{class:'ticket-grid'});
    state.chapterOrder.forEach(function(ck, i){
      var acc = chapterAccuracy(ck);
      var flagCount = chapterFlaggedCount(ck);
      var wordCount = state.chapters[ck].length;
      var ticket = el('div',{class:'ticket' + (flagCount>0 ? ' has-danger': acc!==null ? ' has-progress':''), onclick:function(){ state.activeChapter = ck; state.chapterEditMode = false; state.screen = 'chapterDetail'; render(); }},[
        el('div',{class:'t-left'},[
          el('div',{class:'t-num'},[text('TAB ' + (i+1))]),
          el('div',{class:'t-name kr'},[text(ck)]),
          el('div',{class:'t-meta'},[text(wordCount + (wordCount===1 ? ' word' : ' words'))])
        ]),
        el('div',{class:'t-right'},[
          acc===null
            ? el('div',{class:'t-acc na'},[text('new')])
            : progressRing(acc, {
                cls: (acc>=80?'ring-good':acc>=50?'ring-mid':'ring-low') + (flagCount>0?' has-flag-center':''),
                centerContent: flagCount>0 ? flagCenterContent(flagCount) : null
              }),
          (acc===null && flagCount>0) ? el('div',{class:'t-flag'},[icon('flag'), text(' '+flagCount)]) : null
        ])
      ]);
      grid.appendChild(ticket);
    });
    wrap.appendChild(grid);

    var deckActionsRow = el('div',{class:'options-bar mt-14'});
    deckActionsRow.appendChild(el('button',{class:'ghost-btn', onclick:function(){ state.screen='addmore'; render(); }},[text('+ Add more vocab')]));
    if(state.chapterOrder.length > 1){
      deckActionsRow.appendChild(el('button',{class:'ghost-btn', onclick:function(){ state.screen='reorder'; render(); }},[icon('swap_vert'), text(' Reorder tabs')]));
    }
    wrap.appendChild(deckActionsRow);

    var opts = el('div',{class:'options-bar'});
    opts.appendChild(el('button',{class:'toggle-chip' + (state.timerEnabled?' active':''), onclick:function(){ state.timerEnabled = !state.timerEnabled; saveGlobalPrefs(); render(); }},[text((state.timerEnabled?'⏱ Timer: '+state.timerSeconds+'s':'⏱ Timer off'))]));
    if(state.timerEnabled){
      [8,12,20].forEach(function(sec){
        opts.appendChild(el('button',{class:'toggle-chip' + (state.timerSeconds===sec?' active':''), onclick:function(){ state.timerSeconds = sec; saveGlobalPrefs(); render(); }},[text(sec+'s')]));
      });
    }
    wrap.appendChild(opts);
    return wrap;
  }

  // ---- Reorder chapters screen ----
  function moveChapter(ck, direction){
    var idx = state.chapterOrder.indexOf(ck);
    var newIdx = idx + direction;
    if(idx === -1 || newIdx < 0 || newIdx >= state.chapterOrder.length) return;
    var arr = state.chapterOrder;
    var tmp = arr[idx]; arr[idx] = arr[newIdx]; arr[newIdx] = tmp;
    saveToStorage();
  }
  // ---- Manage Library screen: drag-and-drop reorder + delete for whole decks ----
  // Pointer-based drag (not native HTML5 drag-and-drop) so touch and mouse behave the
  // same. Up/down buttons stay as a fallback for anyone who can't or won't drag.
  function renderManageLibrary(){
    var wrap = el('div',{});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen='library'; render(); }},[icon('arrow_back'), text(' Back')]));
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('Manage Library')]),
      el('p',{},[text('Press and drag a deck to reorder it, or use the arrows. Tap the paint icon to edit its look. Pinned decks always stay grouped at the top.')])
    ]));

    var grid = el('div',{class:'ticket-grid deck-grid manage-grid'});
    var tiles = [];

    function moveDeckBy(id, direction){
      var idx = state.libraryIndex.findIndex(function(d){ return d.id === id; });
      var newIdx = idx + direction;
      if(idx === -1 || newIdx < 0 || newIdx >= state.libraryIndex.length) return;
      var arr = state.libraryIndex;
      var tmp = arr[idx]; arr[idx] = arr[newIdx]; arr[newIdx] = tmp;
      saveLibraryIndex();
      render();
    }

    function moveDeckToIndex(id, targetIdx){
      var idx = state.libraryIndex.findIndex(function(d){ return d.id === id; });
      if(idx === -1 || idx === targetIdx) return;
      var arr = state.libraryIndex;
      var item = arr.splice(idx, 1)[0];
      arr.splice(Math.min(targetIdx, arr.length), 0, item);
      saveLibraryIndex();
      render();
    }

    state.libraryIndex.forEach(function(d, i){
      var wordCount = d.wordCount || 0, chapterCount = d.chapterCount || 0;
      var tile = el('div',{class:'ticket folder-ticket manage-tile'+(d.pinned?' pinned':''), 'data-folder-shape':(d.folderShape || 'x'), 'data-deck-id':d.id},[
        renderFolder(d.folderShape || 'x', d.folderStyle || 'bright', d.folderHue || 0, 'manage-'+d.id),
        el('div',{class:'t-left'},[
          d.pinned ? el('div',{class:'t-fav-row'},[(function(){ var ic=icon('favorite_fill',{cls:'pin-ico'}); ic.style.color='hsl('+(((d.folderHue||0)+180)%360)+',70%,65%)'; return ic; })()]) : null,
          el('div',{class:'t-name kr'},[text(d.name || 'Untitled deck')]),
          el('div',{class:'t-meta'},[text(chapterCount + (chapterCount===1?' tab':' tabs') + ' · ' + wordCount + (wordCount===1?' word':' words'))])
        ]),
        el('div',{class:'manage-tile-controls'},[
          el('button',{class:'manage-tile-btn', title:'Edit folder look', onclick:function(e){ e.stopPropagation(); state.activeDeckId = d.id; state.folderEditorOpen = true; render(); }},[icon('folder_copy')]),
          el('button',{class:'manage-tile-btn manage-tile-del', title:'Delete this deck', onclick:function(e){
            e.stopPropagation();
            askConfirm('Delete "' + (d.name||'this deck') + '" entirely? All its tabs and progress will be lost unless you exported a backup.', function(){
              deleteDeckEntirely(d.id);
              render();
            });
          }},[icon('delete')])
        ]),
        el('div',{class:'manage-tile-updown'},[
          el('button',{class:'reorder-btn', disabled: i===0, onclick:function(e){ e.stopPropagation(); moveDeckBy(d.id, -1); }},[icon('keyboard_arrow_up')]),
          el('button',{class:'reorder-btn', disabled: i===state.libraryIndex.length-1, onclick:function(e){ e.stopPropagation(); moveDeckBy(d.id, 1); }},[icon('keyboard_arrow_down')])
        ])
      ]);
      tiles.push(tile);
      grid.appendChild(tile);
    });
    wrap.appendChild(grid);

    // ---- Pointer-based 2D drag logic ----
    // Move/up listeners sit on document during a drag, since the pointer leaves the tile.
    // Drop targets are found by checking X and Y against each tile's rect (2D grid).
    var dragState = null;
    var LONG_PRESS_MS = 160;

    function findDropTarget(pointerX, pointerY, excludeTile){
      for(var j=0;j<tiles.length;j++){
        if(tiles[j] === excludeTile) continue;
        var rect = tiles[j].getBoundingClientRect();
        if(pointerX >= rect.left && pointerX <= rect.right && pointerY >= rect.top && pointerY <= rect.bottom){
          return j;
        }
      }
      return null;
    }

    function onDragMove(e){
      if(!dragState) return;
      if(!dragState.active){
        // Small movement threshold so a plain tap (open deck) isn't read as a drag.
        var moved = Math.abs(e.clientX - dragState.startX) + Math.abs(e.clientY - dragState.startY);
        if(moved < 6) return;
        dragState.active = true;
        dragState.tile.classList.add('dragging');
      }
      var deltaX = e.clientX - dragState.startX;
      var deltaY = e.clientY - dragState.startY;
      dragState.tile.style.transform = 'translate(' + deltaX + 'px,' + deltaY + 'px)';
      dragState.tile.style.zIndex = '10';

      tiles.forEach(function(t){ t.classList.remove('drop-target'); });
      var targetIdx = findDropTarget(e.clientX, e.clientY, dragState.tile);
      if(targetIdx !== null){
        tiles[targetIdx].classList.add('drop-target');
        dragState.currentTargetIndex = targetIdx;
      }
    }
    function cleanupDrag(){
      if(!dragState) return;
      dragState.tile.classList.remove('dragging');
      dragState.tile.style.transform = '';
      dragState.tile.style.zIndex = '';
      tiles.forEach(function(t){ t.classList.remove('drop-target'); });
      document.removeEventListener('pointermove', onDragMove);
      document.removeEventListener('pointerup', onDragUp);
      document.removeEventListener('pointercancel', onDragCancel);
    }
    function onDragUp(){
      if(!dragState) return;
      var wasActive = dragState.active;
      var id = dragState.id, targetIdx = dragState.currentTargetIndex, originalIdx = dragState.originalIndex;
      cleanupDrag();
      dragState = null;
      if(wasActive && targetIdx !== null && targetIdx !== originalIdx){
        moveDeckToIndex(id, targetIdx);
      }
    }
    function onDragCancel(){ cleanupDrag(); dragState = null; }

    tiles.forEach(function(tile, i){
      tile.addEventListener('pointerdown', function(e){
        if(e.target.closest('.manage-tile-btn') || e.target.closest('.manage-tile-updown')) return;
        var deckId = tile.getAttribute('data-deck-id');
        dragState = { id: deckId, startX: e.clientX, startY: e.clientY, tile: tile, originalIndex: i, currentTargetIndex: i, active: false };
        document.addEventListener('pointermove', onDragMove);
        document.addEventListener('pointerup', onDragUp);
        document.addEventListener('pointercancel', onDragCancel);
      });
      tile.addEventListener('click', function(e){
        if(e.target.closest('.manage-tile-btn') || e.target.closest('.manage-tile-updown')) return;
        if(dragState && dragState.active) return; // suppress the click that follows a real drag
        loadDeck(tile.getAttribute('data-deck-id'));
      });
    });

    return wrap;
  }

  function renderReorderChapters(){
    var wrap = el('div',{});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen='select'; render(); }},[icon('arrow_back'), text(' Back')]));
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('Reorder tabs')]),
      el('p',{},[text('Move tabs up or down — this changes the order they appear in and how "Tab N" numbering reads.')])
    ]));

    var list = el('div',{class:'word-list'});
    state.chapterOrder.forEach(function(ck, i){
      var wordCount = state.chapters[ck].length;
      var row = el('div',{class:'reorder-row'},[
        el('div',{class:'reorder-info'},[
          el('div',{class:'t-num'},[text('TAB ' + (i+1))]),
          el('div',{class:'t-name kr'},[text(ck)]),
          el('div',{class:'t-meta'},[text(wordCount + (wordCount===1?' word':' words'))])
        ]),
        el('div',{class:'reorder-controls'},[
          el('button',{class:'reorder-btn', disabled: i===0, onclick:function(){ moveChapter(ck, -1); render(); }},[icon('keyboard_arrow_up')]),
          el('button',{class:'reorder-btn', disabled: i===state.chapterOrder.length-1, onclick:function(){ moveChapter(ck, 1); render(); }},[icon('keyboard_arrow_down')])
        ])
      ]);
      list.appendChild(row);
    });
    wrap.appendChild(list);
    return wrap;
  }

  // ---- Flagged words detail screen: grouped by chapter, view/unflag/drill ----
  function renderFlaggedDetail(){
    var wrap = el('div',{});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen='select'; render(); }},[icon('arrow_back'), text(' Back')]));

    var total = totalFlagged();
    if(total === 0){
      wrap.appendChild(el('div',{class:'select-header'},[
        el('h1',{},[text('Flagged Words')]),
        el('p',{},[text('Nothing flagged right now — bookmark a word during a drill, or miss it more than you get it, and it\'ll show up here.')])
      ]));
      return wrap;
    }
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('Flagged Words')]),
      el('p',{},[text(total + ' word' + (total===1?'':'s') + ' across your tabs')])
    ]));

    var drillRow = el('div',{class:'options-bar'});
    drillRow.appendChild(el('button',{class:'primary-btn grow', onclick:function(){ openModeSheet(state.chapterOrder.slice(), 'flagged', 'Flagged Words'); }},[icon('play_lesson'), text(' Drill flagged words')]));
    wrap.appendChild(drillRow);

    state.chapterOrder.forEach(function(ck){
      var flaggedWords = state.chapters[ck].filter(function(w){ return w.flagged || w.wrong > w.correct; });
      if(flaggedWords.length === 0) return;
      wrap.appendChild(el('div',{class:'flagged-group-header'},[
        el('span',{class:'kr'},[text(ck)]),
        el('span',{class:'fg-count'},[text(flaggedWords.length + (flaggedWords.length===1?' word':' words'))])
      ]));
      var list = el('div',{class:'word-list'});
      flaggedWords.forEach(function(w){
        var byBookmark = w.flagged;
        var byStats = w.wrong > w.correct;
        var reason = byBookmark && byStats ? 'bookmarked + missed more than hit' : byBookmark ? 'bookmarked' : 'missed more than hit';
        var actionBtn;
        if(byBookmark){
          actionBtn = el('button',{class:'word-del-btn', title:'Remove bookmark', onclick:function(){ toggleFlag(w); render(); }},[icon('bookmark')]);
        } else {
          actionBtn = el('button',{class:'word-del-btn', title:'Reset this word\'s stats', onclick:function(){
            askConfirm('Reset stats for "' + w.term + '"? It\'ll drop off this list once it\'s no longer missed more than hit.', function(){
              w.seen = 0; w.correct = 0; w.wrong = 0; w.box = 1;
              saveToStorage(); render();
            });
          }},[icon('history')]);
        }
        list.appendChild(el('div',{class:'word-view-row flagged'},[
          el('div',{},[
            el('div',{},[
              el('span',{class:'wv-term kr'},[text(w.term)]),
              el('span',{class:'wv-def'},[text(' — ' + w.def)])
            ]),
            el('div',{class:'wv-reason'},[text(reason)])
          ]),
          actionBtn
        ]));
      });
      wrap.appendChild(list);
    });
    return wrap;
  }

  // ---- Chapter editing helpers ----
  // Renaming a chapter means changing its key in state.chapters and its entry in
  // chapterOrder, while keeping its words and its position in the list intact.
  function renameChapter(oldKey, newKey){
    newKey = newKey.trim();
    if(!newKey || newKey === oldKey) return { ok:false, reason: !newKey ? 'empty' : 'unchanged' };
    if(state.chapters[newKey]) return { ok:false, reason:'exists' };
    var idx = state.chapterOrder.indexOf(oldKey);
    if(idx === -1) return { ok:false, reason:'missing' };
    state.chapters[newKey] = state.chapters[oldKey];
    delete state.chapters[oldKey];
    state.chapterOrder[idx] = newKey;
    if(state.activeChapter === oldKey) state.activeChapter = newKey;
    saveToStorage();
    return { ok:true };
  }
  function deleteChapter(ck){
    var idx = state.chapterOrder.indexOf(ck);
    if(idx !== -1) state.chapterOrder.splice(idx,1);
    delete state.chapters[ck];
    saveToStorage();
  }
  function deleteWord(ck, wordId){
    var arr = state.chapters[ck];
    var idx = arr.findIndex(function(w){ return w.id === wordId; });
    if(idx !== -1) arr.splice(idx,1);
    saveToStorage();
  }
  function addWordToChapter(ck, term, def){
    term = term.trim(); def = def.trim();
    if(!term || !def) return false;
    state.chapters[ck].push({ id: uid(), term: term, def: def, box:1, seen:0, correct:0, wrong:0, flagged:false });
    saveToStorage();
    return true;
  }

  // ---- Chapter detail screen: view all words at a glance, launch drills, or edit ----
  function renderChapterDetail(){
    var ck = state.activeChapter;
    if(!ck || !state.chapters[ck]){ state.screen = 'select'; render(); return el('div',{}); }
    var words = state.chapters[ck];
    var wrap = el('div',{class:'chapter-detail-wrap'});

    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen='select'; state.activeChapter=null; render(); }},[icon('arrow_back'), text(' Back')]));

    var titleRow = el('div',{class:'chapter-title-row'});
    if(state.editingChapterName){
      titleRow.appendChild(el('input',{class:'deck-name-input', value: ck, autofocus:true,
        onblur: function(e){ finishRenameChapter(e.target.value); },
        onkeydown: function(e){ if(e.key==='Enter'){ finishRenameChapter(e.target.value); } }
      }));
    } else {
      titleRow.appendChild(el('h1',{class:'kr' + (state.chapterEditMode ? ' editable' : ''), onclick: state.chapterEditMode ? function(){ state.editingChapterName = true; render(); setTimeout(function(){ var i=document.querySelector('.deck-name-input'); if(i) i.focus(); },0); } : null},[text(ck)]));
    }
    wrap.appendChild(titleRow);

    var acc = chapterAccuracy(ck);
    var flagCount = chapterFlaggedCount(ck);
    wrap.appendChild(el('p',{class:'chapter-stats'},[text(words.length + (words.length===1?' word':' words') + (acc!==null ? ' · ' + acc + '% accuracy' : ' · not drilled yet') + (flagCount>0 ? ' · ' + flagCount + ' struggling' : ''))]));

    if(!state.chapterEditMode){
      var drillRow = el('div',{class:'options-bar'});
      drillRow.appendChild(el('button',{class:'primary-btn grow', onclick:function(){ openModeSheet([ck], 'chapter', ck); }},[icon('play_lesson'), text(' Drill this tab')]));
      wrap.appendChild(drillRow);
    }

    wrap.appendChild(el('div',{class:'options-bar'},[
      el('button',{class:'toggle-chip' + (state.chapterEditMode?' active':''), onclick:function(){ state.chapterEditMode = !state.chapterEditMode; state.editingChapterName=false; render(); }},[state.chapterEditMode ? icon('done_all') : icon('edit_square'), text(state.chapterEditMode ? ' Done editing' : ' Edit tab')])
    ]));

    var list = el('div',{class:'word-list'});
    words.forEach(function(w){
      if(state.chapterEditMode){
        var row = el('div',{class:'word-edit-row'});
        var termInput = el('input',{class:'word-edit-input kr', value:w.term, placeholder:'term',
          onblur:function(e){ w.term = e.target.value.trim() || w.term; saveToStorage(); },
          onkeydown:function(e){ if(e.key==='Enter'){ e.target.blur(); } }
        });
        var defInput = el('input',{class:'word-edit-input', value:w.def, placeholder:'definition',
          onblur:function(e){ w.def = e.target.value.trim() || w.def; saveToStorage(); },
          onkeydown:function(e){ if(e.key==='Enter'){ e.target.blur(); } }
        });
        var delBtn = el('button',{class:'word-del-btn', onclick:function(){
          askConfirm('Delete "' + w.term + '"? This removes its progress too.', function(){
            deleteWord(ck, w.id); render();
          });
        }},[icon('delete')]);
        row.appendChild(termInput); row.appendChild(defInput); row.appendChild(delBtn);
        list.appendChild(row);
      } else {
        var isFlagged = w.flagged || w.wrong > w.correct;
        list.appendChild(el('div',{class:'word-view-row'+(isFlagged?' flagged':'')},[
          el('div',{class:'wv-text'},[
            el('span',{class:'wv-term kr'},[text(w.term)]),
            el('span',{class:'wv-def'},[text(w.def)])
          ]),
          el('button',{class:'wv-flag-btn'+(w.flagged?' on':''), title: w.flagged ? 'Remove bookmark' : 'Bookmark this word', onclick:function(){ toggleFlag(w); }},[bookmarkSvg()])
        ]));
      }
    });
    wrap.appendChild(list);

    if(state.chapterEditMode){
      var addRow = el('div',{class:'word-edit-row add-row'});
      var newTerm = el('input',{class:'word-edit-input kr', placeholder:'new term'});
      var newDef = el('input',{class:'word-edit-input', placeholder:'new definition'});
      var addBtn = el('button',{class:'word-del-btn add', onclick:function(){
        if(addWordToChapter(ck, newTerm.value, newDef.value)){ render(); }
      }},[text('+')]);
      addRow.appendChild(newTerm); addRow.appendChild(newDef); addRow.appendChild(addBtn);
      wrap.appendChild(addRow);

      var bulkTa = el('textarea',{placeholder:'term one | definition one\nterm two | definition two\n...', class:'bulk-input'});
      bulkTa.value = state.chapterBulkInput || '';
      bulkTa.addEventListener('input', function(e){ state.chapterBulkInput = e.target.value; });
      var bulkBtn = el('button',{class:'ghost-btn', onclick:function(){
        var parsed = parseVocabText(state.chapterBulkInput || '', ck);
        var totalWords = 0;
        parsed.order.forEach(function(k){ totalWords += parsed.chapters[k].length; });
        if(totalWords === 0){
          var existingErr = wrap.querySelector('.error-msg');
          if(existingErr) existingErr.remove();
          wrap.insertBefore(el('div',{class:'error-msg'},[text('Didn\'t find any valid "term | definition" lines — check the format above.')]), bulkTa);
          return;
        }
        var result = mergeParsedVocab(parsed);
        state.chapterBulkInput = '';
        saveToStorage();
        render();
        var msg = 'Added ' + result.addedWords + ' word' + (result.addedWords===1?'':'s') + ' to "' + ck + '"';
        if(result.addedChapters) msg += ' (plus ' + result.addedChapters + ' other new chapter' + (result.addedChapters===1?'':'s') + ' from headers you included)';
        if(result.skippedDupes) msg += ' — ' + result.skippedDupes + ' duplicate' + (result.skippedDupes===1?'':'s') + ' skipped';
        showToast(msg);
      }},[text('Add pasted words to this tab')]);

      wrap.appendChild(el('div',{class:'reset-progress-zone'},[
        el('div',{class:'dz-title'},[text('ADD MANY AT ONCE')]),
        el('p',{class:'zone-note'},[text('Paste ' ), el('strong',{},[text('term | definition')]), text(' lines, one per row — they\'ll all be added to "' + ck + '". Duplicates are skipped automatically.')]),
        bulkTa,
        bulkBtn
      ]));

      wrap.appendChild(el('div',{class:'danger-zone'},[
        el('div',{class:'dz-title'},[text('DELETE CHAPTER')]),
        el('button',{class:'ghost-btn danger-btn', onclick:function(){
          askConfirm('Delete the entire "' + ck + '" tab and all ' + words.length + ' words in it? This can\'t be undone.', function(){
            deleteChapter(ck);
            state.screen = 'select'; state.activeChapter = null;
            render();
          });
        }},[text('Delete this tab')])
      ]));
    }

    return wrap;
  }
  function finishRenameChapter(val){
    // A rename changes this screen's address; replace the history entry rather than adding one.
    nav.replaceNext = true;
    var result = renameChapter(state.activeChapter, val);
    state.editingChapterName = false;
    if(!result.ok && result.reason === 'exists'){ showToast('A chapter with that name already exists'); }
    render();
  }

  // ---- Custom test screen (pick chapters, then drill just those) ----
  function toggleCustomChapter(ck){
    var idx = state.customTestSelection.indexOf(ck);
    if(idx === -1) state.customTestSelection.push(ck);
    else state.customTestSelection.splice(idx, 1);
    render();
  }
  function renderCustomTest(){
    var wrap = el('div',{});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen='select'; render(); }},[icon('arrow_back'), text(' Back')]));
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('Custom Test')]),
      el('p',{},[text('Pick as many tabs as you want — they\'ll get shuffled together into one drill, same as Final Mode.')])
    ]));

    var grid = el('div',{class:'ticket-grid'});
    state.chapterOrder.forEach(function(ck, i){
      var acc = chapterAccuracy(ck);
      var flagCount = chapterFlaggedCount(ck);
      var wordCount = state.chapters[ck].length;
      var selected = state.customTestSelection.indexOf(ck) !== -1;
      var ticket = el('div',{
        class:'ticket' + (flagCount>0 ? ' has-danger': acc!==null ? ' has-progress':'') + (selected ? ' picked':''),
        onclick:function(){ toggleCustomChapter(ck); }
      },[
        el('div',{class:'t-left'},[
          el('div',{class:'t-num'},[text('TAB ' + (i+1))]),
          el('div',{class:'t-name kr'},[text(ck)]),
          el('div',{class:'t-meta'},[text(wordCount + (wordCount===1 ? ' word' : ' words'))])
        ]),
        el('div',{class:'t-right'},[
          el('div',{class:'pick-check'+(selected?' on':'')},[text(selected?'✓':'')])
        ])
      ]);
      grid.appendChild(ticket);
    });
    wrap.appendChild(grid);

    var n = state.customTestSelection.length;
    var startBtn = el('button',{
      class:'primary-btn mt-16',
      disabled: n===0,
      onclick:function(){
        if(n===0) return;
        openModeSheet(state.customTestSelection.slice(), 'all', 'Custom Test (' + n + ' ch.)');
      }
    },[text(n===0 ? 'Pick at least one tab' : 'Start test with ' + n + ' tab' + (n===1?'':'s') + ' '), n>0?icon('arrow_forward'):null]);
    wrap.appendChild(startBtn);
    return wrap;
  }

  // ---- Export shareable set screen (pick chapters, strip progress, download) ----
  function toggleExportChapter(ck){
    var idx = state.exportSelection.indexOf(ck);
    if(idx === -1) state.exportSelection.push(ck);
    else state.exportSelection.splice(idx, 1);
    render();
  }
  function renderExportPicker(){
    var wrap = el('div',{});
    wrap.appendChild(el('button',{class:'back-link', onclick:function(){ state.screen = state.chapterOrder.length ? 'select':'loader'; openSideMenu('deck'); }},[icon('arrow_back'), text(' Back')]));
    wrap.appendChild(el('div',{class:'select-header'},[
      el('h1',{},[text('Export a shareable set')]),
      el('p',{},[text('Pick which tabs to share. The file will have just the words — no progress, stats, or bookmarks — so whoever imports it starts fresh.')])
    ]));

    var allSelected = state.exportSelection.length === state.chapterOrder.length && state.chapterOrder.length > 0;
    wrap.appendChild(el('button',{class:'ghost-btn mb-12', onclick:function(){
      state.exportSelection = allSelected ? [] : state.chapterOrder.slice();
      render();
    }},[text(allSelected ? 'Deselect all' : 'Select all tabs')]));

    var grid = el('div',{class:'ticket-grid'});
    state.chapterOrder.forEach(function(ck, i){
      var wordCount = state.chapters[ck].length;
      var selected = state.exportSelection.indexOf(ck) !== -1;
      var ticket = el('div',{
        class:'ticket' + (selected ? ' picked':''),
        onclick:function(){ toggleExportChapter(ck); }
      },[
        el('div',{class:'t-left'},[
          el('div',{class:'t-num'},[text('TAB ' + (i+1))]),
          el('div',{class:'t-name kr'},[text(ck)]),
          el('div',{class:'t-meta'},[text(wordCount + (wordCount===1 ? ' word' : ' words'))])
        ]),
        el('div',{class:'t-right'},[
          el('div',{class:'pick-check'+(selected?' on':'')},[text(selected?'✓':'')])
        ])
      ]);
      grid.appendChild(ticket);
    });
    wrap.appendChild(grid);

    var n = state.exportSelection.length;
    var exportBtn = el('button',{
      class:'primary-btn mt-16',
      disabled: n===0,
      onclick:function(){
        if(n===0) return;
        exportShareableSet(state.exportSelection.slice());
        showToast('Exported ' + n + ' chapter' + (n===1?'':'s') + ' — ready to share');
      }
    },[text(n===0 ? 'Pick at least one tab' : 'Export ' + n + ' tab' + (n===1?'':'s') + ' '), n>0?icon('arrow_forward'):null]);
    wrap.appendChild(exportBtn);
    return wrap;
  }

  // ---- Mode picker sheet ----
  function openModeSheet(chapterKeys, filterMode, label){
    state.modeSheet = {chapterKeys:chapterKeys, filterMode:filterMode, label:label};
    state.modeSheetReversed = false;
    render();
  }
  function renderModeSheet(){
    var ms = state.modeSheet;
    var overlay = el('div',{class:'sheet-overlay', onclick:function(e){ if(e.target === e.currentTarget){ state.modeSheet=null; render(); } }});
    var sheet = el('div',{class:'sheet'});
    sheet.appendChild(el('h3',{},[text(ms.label)]));
    sheet.appendChild(el('p',{class:'sub'},[text('Pick your study mode')]));

    sheet.appendChild(el('div',{class:'direction-toggle'},[
      el('button',{class:'toggle-chip'+(!state.modeSheetReversed?' active':''), onclick:function(){ state.modeSheetReversed=false; render(); }},[text('TERM FIRST')]),
      el('button',{class:'toggle-chip'+(state.modeSheetReversed?' active':''), onclick:function(){ state.modeSheetReversed=true; render(); }},[text('DEFINITION FIRST')])
    ]));

    var options = [
      {ico:'cards_stack', label:'FLIP CARDS', desc:'Classic — see it, think it, flip to check', fn:startFlipSession},
      {ico:'list_alt', label:'MULTIPLE CHOICE', desc:'Pick the right meaning from 4 options', fn:startMCSession},
      {ico:'join_right', label:'MATCH PAIRS', desc:'Tap to pair terms with meanings, 6 at a time', fn:startMatchSession}
    ];
    options.forEach(function(opt){
      sheet.appendChild(el('div',{class:'sheet-option', onclick:function(){
        var reversed = state.modeSheetReversed;
        state.modeSheet = null;
        opt.fn(ms.chapterKeys, ms.filterMode, reversed);
      }},[
        el('span',{class:'emoji'},[icon(opt.ico)]),
        el('div',{},[ el('div',{class:'label'},[text(opt.label)]), el('div',{class:'desc'},[text(opt.desc)]) ])
      ]));
    });
    sheet.appendChild(el('button',{class:'sheet-cancel', onclick:function(){ state.modeSheet=null; render(); }},[text('Cancel')]));
    overlay.appendChild(sheet);
    return overlay;
  }

  // ---- Drill router ----
  function renderDrillRouter(){
    var s = state.session;
    if(s.type === 'flip') return renderFlipDrill();
    if(s.type === 'mc') return renderMCDrill();
    if(s.type === 'match') return renderMatchDrill();
  }

  function drillHeader(indexLabel, totalLabel, progressPct){
    return el('div',{class:'drill-header'},[
      el('button',{class:'back-link', onclick:function(){ askConfirm('End this session early? Progress so far is already saved.', endSessionEarly); }},[icon('arrow_back'), text(' Exit')]),
      el('div',{class:'progress-track'},[el('div',{class:'progress-fill', style:'width:'+progressPct+'%'})]),
      el('span',{class:'counter'},[text(indexLabel+' / '+totalLabel)])
    ]);
  }
  function timerBarEl(){
    return el('div',{class:'timer-bar-wrap', id:'timerBarWrap'},[ el('div',{class:'timer-bar', id:'timerBarFill', style:'width:100%'}) ]);
  }

  // ---- Flip drill ----
  function renderFlipDrill(){
    var s = state.session;
    var current = s.queue[s.index];
    var w = current.ref;
    var wrap = el('div',{});
    wrap.appendChild(drillHeader(s.index+1, s.queue.length, (s.index/s.queue.length*100)));
    if(state.timerEnabled) wrap.appendChild(timerBarEl());

    var stage = el('div',{class:'card-stage'});
    var isFlagged = w.flagged || w.wrong > w.correct;

    var frontFace = el('div',{class:'face'},[
      el('div',{class:'face-content'},[
        el('span',{class:'chapter-tag'},[text(current.chKey)]),
        el('div',{class:promptClass()},[text(promptText(w))]),
        el('div',{class:'tap-hint'},[text('TAP TO REVEAL')])
      ])
    ]);
    var backFace = el('div',{class:'face back'},[
      el('div',{class:'face-content'},[
        el('span',{class:'chapter-tag'},[text(current.chKey)]),
        el('div',{class:answerClass()},[text(answerText(w))]),
        el('div',{class:'tap-hint'},[text('TAP TO FLIP BACK')])
      ])
    ]);
    var card = el('div',{class:'flashcard'+(s.flipped?' flipped':''), onclick:flipCard},[frontFace, backFace]);
    var cardShell = el('div',{class:'flashcard-shell'},[
      card,
      el('div',{class:'fold-b'+(isFlagged?' on':'')}),
      el('div',{class:'fold-c'+(isFlagged?' on':'')}),
      el('button',{class:'bookmark-zone', onclick:function(e){ e.stopPropagation(); toggleFlag(w); }},[
        isFlagged ? null : el('span',{class:'bookmark-icon'},[bookmarkSvg()])
      ])
    ]);
    stage.appendChild(cardShell);
    attachSwipeHandlers(cardShell, cardShell);

    stage.appendChild(el('div',{class:'action-row'},[
      el('button',{class:'action-btn btn-wrong', onclick:function(){ markFlip(false); }},[el('span',{class:'big'},[icon('cancel')]), text('MISSED IT')]),
      el('button',{class:'action-btn btn-correct', onclick:function(){ markFlip(true); }},[el('span',{class:'big'},[icon('check_circle')]), text('GOT IT')])
    ]));
    stage.appendChild(el('div',{class:'hint-row'},[text('Flip the card, then mark honestly — misses come back around more often~')]));
    wrap.appendChild(stage);
    return wrap;
  }

  // ---- MC drill ----
  function renderMCDrill(){
    var s = state.session;
    var current = s.queue[s.index];
    var w = current.ref;
    var wrap = el('div',{});
    wrap.appendChild(drillHeader(s.index+1, s.queue.length, (s.index/s.queue.length*100)));
    if(state.timerEnabled) wrap.appendChild(timerBarEl());

    var stage = el('div',{class:'mc-stage'});
    var isFlagged = w.flagged || w.wrong > w.correct;
    stage.appendChild(el('div',{class:'mc-prompt-card'+(isFlagged?' flagged':'')},[
      el('div',{class:'fold-b'}),
      el('div',{class:'fold-c'}),
      el('div',{class:'mc-prompt-content'},[
        el('span',{class:'chapter-tag'},[text(current.chKey)]),
        el('div',{class:promptClass()},[text(promptText(w))])
      ])
    ]));

    var optsWrap = el('div',{class:'mc-options'});
    s.options.forEach(function(opt, idx){
      var cls = 'mc-option';
      if(s.answered){
        cls += ' disabled';
        if(opt.correct) cls += ' correct';
        else if(idx === s.chosenIdx) cls += ' wrong';
      }
      optsWrap.appendChild(el('button',{class:cls, onclick:function(){ chooseMC(idx); }},[text(opt.text)]));
    });
    stage.appendChild(optsWrap);
    if(s.answered){
      stage.appendChild(el('div',{class:'mc-next-hint'},[text(s.chosenIdx>=0 && s.options[s.chosenIdx].correct ? 'Nice, got it! Next...' : 'Close — moving on...')]));
    } else {
      stage.appendChild(el('div',{class:'hint-row'},[text('Pick the correct meaning')]));
    }
    wrap.appendChild(stage);
    return wrap;
  }

  // ---- Match drill ----
  function renderMatchDrill(){
    var s = state.session;
    var wrap = el('div',{});
    var doneCount = s.roundIndex + s.lockedIds.length;
    wrap.appendChild(drillHeader(Math.min(doneCount+1, s.fullQueue.length), s.fullQueue.length, (doneCount/s.fullQueue.length*100)));

    var stage = el('div',{class:'match-stage'});
    var cols = el('div',{class:'match-cols'});
    var termCol = el('div',{class:'match-col'});
    var defCol = el('div',{class:'match-col'});

    var termIsKr = !(state.session && state.session.reversed);
    s.termTiles.forEach(function(tile){
      var locked = s.lockedIds.indexOf(tile.id) !== -1;
      var selected = s.selectedTerm && s.selectedTerm.id === tile.id;
      var cls = 'match-tile' + (termIsKr?' kr':'') + (locked?' locked':'') + (selected?' selected':'') + (shakeIds['term'+tile.id]?' shake':'');
      termCol.appendChild(el('div',{class:cls, onclick:function(){ selectMatchTile('term', tile); }},[text(tile.text)]));
    });
    s.defTiles.forEach(function(tile){
      var locked = s.lockedIds.indexOf(tile.id) !== -1;
      var selected = s.selectedDef && s.selectedDef.id === tile.id;
      var cls = 'match-tile' + (termIsKr?'':' kr') + (locked?' locked':'') + (selected?' selected':'') + (shakeIds['def'+tile.id]?' shake':'');
      defCol.appendChild(el('div',{class:cls, onclick:function(){ selectMatchTile('def', tile); }},[text(tile.text)]));
    });
    cols.appendChild(termCol); cols.appendChild(defCol);
    stage.appendChild(cols);
    stage.appendChild(el('div',{class:'match-progress'},[text('Round: ' + s.lockedIds.length + ' / ' + s.currentRound.length + ' paired')]));
    wrap.appendChild(stage);
    return wrap;
  }

  // ---- Summary screen ----
  function renderSummary(){
    var s = state.session;
    var total = s.correctCount + s.wrongCount;
    var pct = total>0 ? Math.round((s.correctCount/total)*100) : 0;
    var wrap = el('div',{class:'summary-wrap'});
    wrap.appendChild(el('h1',{},[text(pct>=80?'Nice work! ':pct>=50?'Good, keep going':'Run it again? You got this'), pct>=80?icon('star_shine',{cls:'summary-star'}):null]));
    wrap.appendChild(el('div',{class:'summary-stats'},[
      el('div',{class:'stat-box jade'},[el('div',{class:'n'},[text(s.correctCount)]), el('div',{class:'l'},[text('Got it')])]),
      el('div',{class:'stat-box red'},[el('div',{class:'n'},[text(s.wrongCount)]), el('div',{class:'l'},[text('Missed')])]),
      el('div',{class:'stat-box'},[el('div',{class:'n'},[text(pct+'%')]), el('div',{class:'l'},[text('Accuracy')])])
    ]));
    if(s.missed.length){
      wrap.appendChild(el('p',{class:'summary-note'},[text('Missed this round — auto-flagged for next time:')]));
      var list = el('div',{class:'miss-list'});
      s.missed.forEach(function(m){ list.appendChild(el('div',{class:'miss-row'},[el('span',{class:'k kr'},[text(m.term)]), el('span',{class:'m'},[text(m.def)])])); });
      wrap.appendChild(list);
    }
    wrap.appendChild(el('div',{class:'row'},[
      el('button',{class:'ghost-btn', onclick:function(){ state.session=null; state.screen='select'; render(); }},[text('Back to tabs')]),
      el('button',{class:'primary-btn', onclick:function(){
        var t = s.type;
        if(t==='flip') startFlipSession(s.chapterKeys, s.mode, s.reversed);
        else if(t==='mc') startMCSession(s.chapterKeys, s.mode, s.reversed);
        else startMatchSession(s.chapterKeys, s.mode, s.reversed);
      }},[text('Drill again')])
    ]));
    wrap.appendChild(el('button',{class:'ghost-btn', onclick:exportState},[icon('download'), text(' Save progress to file')]));
    return wrap;
  }

  applyTheme();
  render();
  bootApp();

  // Offline support for the installed app (see sw.js). Skipped inside Claude previews and file:// pages.
  if('serviceWorker' in navigator && !storage.isNative && location.protocol !== 'file:'){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(){});
    });
  }
})();
