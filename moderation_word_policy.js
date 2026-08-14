'use strict';

const DOX_WORDS = new Set(['dox', 'doxxing', 'doxxed']);

function isDoxWord(word) {
    return DOX_WORDS.has(String(word || '').trim().toLowerCase());
}

function findDoxWord(content) {
    const words = String(content || '').toLowerCase().match(/[a-z]+/g) || [];
    return words.find(isDoxWord) || null;
}

function bannedWordAction(word) {
    return isDoxWord(word)
        ? { deleteMessage: true, postScold: true, incrementOffense: false, jail: false }
        : { deleteMessage: true, postScold: false, incrementOffense: true, jail: true };
}

module.exports = { DOX_WORDS, isDoxWord, findDoxWord, bannedWordAction };
