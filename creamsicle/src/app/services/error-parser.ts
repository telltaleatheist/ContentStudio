export interface ParsedError {
  title: string;
  message: string;
  technical?: string;
}

export class ErrorParser {
  static parse(error: any): ParsedError {
    let title = 'Error';
    let message = 'An unexpected error occurred.';
    let technical = '';

    if (typeof error === 'string') {
      technical = error;

      const errorMatch = error.match(/Claude request error: Error code: (\d+) - (.+)/);
      if (errorMatch) {
        const errorCode = errorMatch[1];
        const errorDetails = errorMatch[2];

        try {
          const jsonMatch = errorDetails.match(/\{[^}]+\}/);
          if (jsonMatch) {
            const errorObj = JSON.parse(jsonMatch[0]);
            if (errorObj.error && errorObj.error.message) {
              technical = `Error ${errorCode}: ${errorObj.error.message}`;
            }
          }
        } catch (e) {
          technical = `Error ${errorCode}: ${errorDetails}`;
        }
      }

      if (error.includes('model:') && (error.includes('not_found_error') || error.includes('404'))) {
        const modelMatch = error.match(/['"]?model['"]?:\s*['"]?([\w\-.:]+)['"]?/);
        if (modelMatch) {
          const modelName = modelMatch[1];
          title = 'Invalid AI Model';
          message = `The AI model "${modelName}" is not available. Please check your Settings and select a valid model.`;
        }
      } else if (error.includes('404') && !error.includes('model:')) {
        title = 'Resource Not Found';
        message = 'The requested resource could not be found.';
      } else if (error.includes('401') || error.includes('Unauthorized')) {
        title = 'Authentication Error';
        message = 'Your API key is invalid or has expired. Please check your settings.';
      } else if (error.includes('429') || error.includes('rate limit')) {
        title = 'Rate Limited';
        message = 'Too many requests. Please wait a moment and try again.';
      } else if (error.includes('500') || error.includes('Internal Server Error')) {
        title = 'Server Error';
        message = 'The AI service is experiencing issues. Please try again later.';
      } else if (error.includes('Failed to generate any metadata')) {
        title = 'Metadata Generation Failed';
        message = 'Unable to generate metadata for any of the inputs.';
      } else if (error.includes('ENOENT') || error.includes('does not exist')) {
        title = 'File Not Found';
        message = 'The specified file or directory could not be found.';
      } else if (error.includes('EACCES') || error.includes('permission denied')) {
        title = 'Permission Denied';
        message = 'You don\'t have permission to access this file or directory.';
      } else {
        const firstLine = error.split('\n')[0];
        if (firstLine.length < 150) {
          message = firstLine;
        } else {
          message = error;
        }
      }
    } else if (error instanceof Error) {
      technical = error.message;
      title = error.name || 'Error';
      message = error.message;
    } else if (error && typeof error === 'object') {
      if (error.error) {
        return this.parse(error.error);
      }
      if (error.message) {
        technical = error.message;
        message = error.message;
      }
      if (error.statusText) {
        title = error.statusText;
      }
    }

    return { title, message, technical };
  }

  static formatForDisplay(error: any): { title: string; message: string } {
    const parsed = this.parse(error);
    return { title: parsed.title, message: parsed.message };
  }

  static formatWithTechnical(error: any): { title: string; message: string } {
    const parsed = this.parse(error);
    let fullMessage = parsed.message;

    if (parsed.technical && parsed.technical !== parsed.message) {
      fullMessage += `\n\nTechnical details:\n${parsed.technical}`;
    }

    return { title: parsed.title, message: fullMessage };
  }
}
