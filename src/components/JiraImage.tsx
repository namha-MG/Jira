import React, { useEffect, useState } from 'react';
import axios from 'axios';

interface JiraImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src?: string;
}

const getAuthHeader = () => {
  const pat = localStorage.getItem("jira_pat");
  if (pat) {
    return { Authorization: `Bearer ${pat}` };
  }
  const basic = localStorage.getItem("jira_basic");
  if (basic) {
    return { Authorization: `Basic ${basic}` };
  }
  return {};
};

export const JiraImage: React.FC<JiraImageProps> = ({ src, alt, ...props }) => {
  const [blobUrl, setBlobUrl] = useState<string>('');
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (!src) return;

    let isMounted = true;

    // Rewrite the url to use the vite proxy if it's an absolute url
    let fetchUrl = src;
    try {
      if (src.startsWith('http')) {
        const urlObj = new URL(src);
        fetchUrl = `/jira-api${urlObj.pathname}${urlObj.search}`;
      } else if (!src.startsWith('/jira-api')) {
        fetchUrl = `/jira-api${src.startsWith('/') ? '' : '/'}${src}`;
      }
    } catch (e) {
      // Ignored
    }

    axios.get(fetchUrl, {
      responseType: 'blob',
      headers: {
        ...getAuthHeader(),
        "X-Atlassian-Token": "no-check"
      }
    }).then(res => {
      if (isMounted) {
        const url = URL.createObjectURL(res.data);
        setBlobUrl(url);
      }
    }).catch(err => {
      if (isMounted) {
        setError(true);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [src]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  if (!src) return null;
  
  if (error) {
    // Return original image if fetch failed (might trigger cert error, but it's the fallback)
    return <img src={src} alt={alt} {...props} />;
  }

  if (!blobUrl) {
    // Can return a placeholder or empty while loading, but keeping dimensions is good.
    // An empty span or a skeleton could work, but a transparent gif is simpler.
    return <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt={alt} {...props} />;
  }

  return <img src={blobUrl} alt={alt} {...props} />;
};
