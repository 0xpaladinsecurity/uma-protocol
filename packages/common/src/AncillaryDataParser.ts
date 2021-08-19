import type Web3 from "web3";
import dotenv from "dotenv";
dotenv.config();

/**
 * @title Parse ancillary data.
 * @notice Ancillary data parser implementation following guidelines at:
 * https://docs.google.com/document/d/1zhKKjgY1BupBGPPrY_WOJvui0B6DMcd-xDR8-9-SPDw/edit
 * @param {Web3} Web3 instance for accessing important utility functions
 * @param {String} hex string representation of ancillaryData
 * @return {Object} parsed ancillary data object.
 */
export function parseAncillaryData(web3: Web3, ancillaryData: string): any {
  // Some requesting contracts set the synthetic token address as ancillary data, so try to parse it first:
  if (web3.utils.isAddress(ancillaryData)) return { address: ancillaryData };
  let ancillaryString;
  try {
    ancillaryString = web3.utils.hexToUtf8(ancillaryData);
  } catch (err) {
    throw "Cannot parse ancillary data bytes to UTF-8!";
  }
  return parseAncillaryString(ancillaryString);
}

// Parses ancillary data string to object.
function parseAncillaryString(ancillaryString: string): any {
  const stringObject: any = [];
  const ancillaryObject: any = {};
  ancillaryString.split("").forEach((character) => {
    stringObject.push({ character: character, escape: false, skip: false });
  });
  markEscapes(stringObject);
  const keyValues = splitKeyValues(stringObject);
  keyValues.forEach((keyValue: any) => {
    const [key, value] = parseKeyValue(keyValue);
    ancillaryObject[key] = value;
  });
  return ancillaryObject;
}

// Escapes double quoted keys/values and values enclosed in curly/square brackets.
function markEscapes(stringObject: any) {
  stringObject.forEach((charObject: any, openIndex: number, stringObject: any) => {
    // Skip searching in already escaped characters or closing double quotes:
    if (charObject.escape || charObject.skip) return;

    // Escape keys: opening quotes should be after comma (,) separator or start.
    if (
      charObject.character == '"' &&
      (isNextEnd(stringObject, openIndex, false) || isNextChar(stringObject, openIndex, ",", false))
    )
      escapeQuotes(stringObject, openIndex, false);

    // Escape string values: opening quotes should be after column (:) separator.
    if (charObject.character == '"' && isNextChar(stringObject, openIndex, ":", false))
      escapeQuotes(stringObject, openIndex);

    // Escape JSON values: first opening curly brackets should be after column (:) separator.
    if (charObject.character == "{" && isNextChar(stringObject, openIndex, ":", false))
      escapeJSON(stringObject, openIndex);

    // Escape JSON values: first opening square brackets should be after column (:) separator.
    if (charObject.character == "[" && isNextChar(stringObject, openIndex, ":", false))
      escapeJSON(stringObject, openIndex, false);
  });
}

// Splits ancillary data object into key-value pairs.
function splitKeyValues(stringObject: any): any {
  const keyValues: any = [];
  for (let startIndex = 0; startIndex < stringObject.length; startIndex++) {
    const charObject: any = stringObject[startIndex];

    // If reached unescaped comma (,) continue with the next key-value pair:
    if (!skipWhitespace(charObject) || (charObject.character == "," && !charObject.escape)) continue;

    for (let endIndex = startIndex; endIndex < stringObject.length; endIndex++) {
      // Search for next unescaped comma (,) delimiter or end of object:
      if (
        endIndex == stringObject.length - 1 ||
        isNextEnd(stringObject, endIndex) ||
        isNextChar(stringObject, endIndex, ",")
      ) {
        // Copy the identified key-value pair:
        const pairIndex = keyValues.length;
        keyValues.push([]);
        for (let i = startIndex; i <= endIndex; i++) {
          keyValues[pairIndex].push(stringObject[i]);
        }

        // Skip start index to the end of current key-value pair:
        startIndex = endIndex;
        break;
      }
    }
  }

  // Remove enclosing double quotes.
  keyValues.forEach((keyValue: any, index: number, keyValues: any) => {
    keyValues[index] = keyValue.filter(removeDoubleQuotes);
  });
  return keyValues;
}

// Tries to parse key:value pair.
function parseKeyValue(keyValue: any): any {
  let key = "";
  let value = "";

  // Skip unescaped whitespace:
  let index = keyValue.findIndex(skipWhitespace) == -1 ? keyValue.length : keyValue.findIndex(skipWhitespace);

  while (index < keyValue.length) {
    const skip =
      keyValue.slice(index).findIndex(skipWhitespace) == -1 ? 0 : keyValue.slice(index).findIndex(skipWhitespace);

    // Reached unescaped column (:) delimiter:
    if (keyValue[index + skip].character == ":" && !keyValue[index + skip].escape) {
      index += 1 + skip;
      // Return processed key and empty value if reached the end of keyValue pair:
      if (index == keyValue.length && key) {
        return [key, ""];
      } else {
        break;
      }
    }
    key = key.concat(keyValue[index].character);
    index++;
  }

  // No column (:) delimiter found, but reached the end of keyValue pair:
  if (index == keyValue.length) throw "Cannot parse key value pair: no column delimiter found!";

  // Skip unescaped whitespace
  index +=
    keyValue.slice(index).findIndex(skipWhitespace) == -1
      ? keyValue.slice(index).length
      : keyValue.slice(index).findIndex(skipWhitespace);

  while (index < keyValue.length) {
    const skip =
      keyValue.slice(index).findIndex(skipWhitespace) == -1 ? 0 : keyValue.slice(index).findIndex(skipWhitespace);

    // There should be only one unescaped column (:) delimiter in the keyValue pair:
    if (keyValue[index + skip].character == ":" && !keyValue[index + skip].escape)
      throw "Cannot parse key value pair: multiple column delimiters found!";

    value = value.concat(keyValue[index].character);
    index++;
  }
  if (!key || !value) throw "Cannot parse key value pair!";

  // First try parsing value as JSON object:
  try {
    return [key, JSON.parse(value)];
  } catch (err) {
    // Then parse as Number or return string value:
    if (value == Number(value).toString()) {
      return [key, Number(value)];
    } else {
      return [key, value];
    }
  }
}

// Checks if reached end/start without whitespace.
function isNextEnd(stringObject: any, start: number, forward = true): boolean {
  if (forward) {
    return stringObject.slice(start + 1).findIndex(skipWhitespace) == -1;
  } else {
    return stringObject.slice(0, start).reverse().findIndex(skipWhitespace) == -1;
  }
}

// Checks if next non-whitespace character forward/backward matches the provided input character.
export function isNextChar(stringObject: any, start: number, character: any, forward = true): boolean {
  if (forward) {
    const nextCharIndex = stringObject.slice(start + 1).findIndex(skipWhitespace);
    if (nextCharIndex == -1) {
      return false;
    } else {
      return (
        stringObject[start + 1 + nextCharIndex].character == character &&
        !stringObject[start + 1 + nextCharIndex].escape
      );
    }
  } else {
    const nextCharIndex = stringObject.slice(0, start).reverse().findIndex(skipWhitespace);
    if (nextCharIndex == -1) {
      return false;
    } else {
      return (
        stringObject[start - 1 - nextCharIndex].character == character &&
        !stringObject[start - 1 - nextCharIndex].escape
      );
    }
  }
}

/**
 * Finds closing quotes for keys/values and marks escaped.
 * For values: closing quotes should be either before comma (,) or at the end.
 * For keys: closing quotes should be before column (:).
 */
function escapeQuotes(stringObject: any, openIndex: number, escapeValues = true): boolean {
  const nextCharFn = escapeValues
    ? function (stringObject: any, closeIndex: number) {
        return isNextEnd(stringObject, closeIndex) || isNextChar(stringObject, closeIndex, ",");
      }
    : function (stringObject: any, closeIndex: number) {
        return isNextChar(stringObject, closeIndex, ":");
      };
  for (let closeIndex = openIndex + 1; closeIndex < stringObject.length; closeIndex++) {
    if (stringObject[closeIndex].character == '"' && nextCharFn(stringObject, closeIndex)) {
      for (let i = openIndex + 1; i < closeIndex; i++) {
        stringObject[i].escape = true;
      }
      stringObject[openIndex].skip = true;
      stringObject[closeIndex].skip = true;
      break;
    }
  }
}

// Finds closing brackets for JSON value and marks escaped: last closing brackets should be either before comma (,) or at the end.
function escapeJSON(stringObject: any, openIndex: number, curly = true) {
  const openChar = curly ? "{" : "[";
  const closeChar = curly ? "}" : "]";
  let nestingLevel = 1;
  for (let closeIndex = openIndex + 1; closeIndex < stringObject.length; closeIndex++) {
    if (stringObject[closeIndex].character == openChar) nestingLevel++;
    if (stringObject[closeIndex].character == closeChar) nestingLevel--;
    if (
      stringObject[closeIndex].character == closeChar &&
      nestingLevel == 0 &&
      (isNextEnd(stringObject, closeIndex) || isNextChar(stringObject, closeIndex, ","))
    ) {
      for (let i = openIndex + 1; i < closeIndex; i++) {
        stringObject[i].escape = true;
      }
      break;
    }
  }
}

// Checks whether the passed character object does not represent whitespace.
function skipWhitespace(charObject: any) {
  const whitespaceCharacters = " \t\n\r".split("");
  return !whitespaceCharacters.includes(charObject.character) || charObject.escape;
}

// Used to filter out double quotes.
function removeDoubleQuotes(charObject: any) {
  return !charObject.skip;
}